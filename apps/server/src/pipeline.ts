import type { Posting, Profile, RequirementMatch } from "@ia/core";
import {
  applyHardFilters,
  computeFitScore,
  detectSponsorship,
  detectTerms,
  finalizePosting,
  isInternshipTitle,
  keywordRequirementMatch,
  markMissing,
  upsertAll,
} from "@ia/core";
import type { LlmClient } from "@ia/ai";
import { matchRequirements, profileForModel, UsageLimitError } from "@ia/ai";
import type { FetchFn } from "@ia/sources";
import { canEnrich, fetchPostingDetail, HostRateLimiter, pollSources } from "@ia/sources";
import type { Store } from "./db.ts";
import { mapLimit, shortHash } from "./util.ts";

export interface PipelineDeps {
  store: Store;
  profile: Profile;
  fetch: FetchFn;
  llm: LlmClient | null;
  now?: () => Date;
  log?: (msg: string) => void;
}

export interface SourcingReport {
  fetched: number;
  kept: number;
  added: number;
  merged: number;
  closed: number;
  errors: string[];
}

/** Drop rows that can't be relevant before they reach the database. */
function relevant(p: Posting, profile: Profile): boolean {
  if (!isInternshipTitle(p.title) && !p.sources.includes("simplify")) return false;
  const known = p.terms.filter((t) => t !== "N/A");
  return known.length === 0 || known.some((t) => profile.preferences.terms.includes(t));
}

export async function runSourcing(
  deps: PipelineDeps,
  opts: { includeSimplify?: boolean } = {},
): Promise<SourcingReport> {
  const { store, profile } = deps;
  const now = (deps.now?.() ?? new Date()).toISOString();
  const poll = await pollSources({
    fetch: deps.fetch,
    watchlist: profile.preferences.watchlist,
    now: deps.now?.() ?? new Date(),
    ...(opts.includeSimplify === undefined ? {} : { includeSimplify: opts.includeSimplify }),
  });
  const errors: string[] = [];
  if (opts.includeSimplify !== false) {
    store.logPoll("simplify", !poll.simplifyError, poll.simplifyError, poll.simplify.length);
    if (poll.simplifyError) errors.push(`simplify: ${poll.simplifyError}`);
  }
  for (const b of poll.boards) {
    store.logPoll(b.board, !b.error, b.error, b.postings.length);
    if (b.error) errors.push(`${b.board}: ${b.error}`);
  }

  const raws = [...poll.simplify, ...poll.boards.flatMap((b) => b.postings)];
  const incoming = raws.map((r) => finalizePosting(r, now)).filter((p) => relevant(p, profile));
  const before = store.allPostings();
  const merged = upsertAll(before, incoming);
  let postings = merged.postings;

  // Board-level closing: a role an API stopped listing gets a strike per poll; two strikes closes it.
  for (const b of poll.boards) {
    if (b.error) continue;
    const seen = new Set(b.postings.map((r) => finalizePosting(r, now).id));
    postings = markMissing(postings, seen, b.owns);
  }
  // A posting the open-check found closed stays closed, even if a list still shows it.
  const expired = store.expiredPostingIds();
  postings = postings.map((p) => (p.isOpen && expired.has(p.id) ? { ...p, isOpen: false } : p));
  const wasOpen = new Set(before.filter((p) => p.isOpen).map((p) => p.id));
  const closed = postings.filter((p) => !p.isOpen && wasOpen.has(p.id)).length;
  store.savePostings(postings);
  return {
    fetched: raws.length,
    kept: incoming.length,
    added: merged.added,
    merged: merged.merged,
    closed,
    errors,
  };
}

export interface ScoringReport {
  considered: number;
  passed: number;
  dropped: number;
  modelCalls: number;
  reused: number;
}

/**
 * Filter and score every open posting. The model is asked only when the posting text or the
 * profile changed since the last score; otherwise the stored requirement match is reused and
 * only the cheap, time-dependent parts (freshness) are recomputed.
 */
export async function runScoring(
  deps: PipelineDeps,
  opts: { concurrency?: number } = {},
): Promise<ScoringReport> {
  const { store, profile, llm } = deps;
  const now = deps.now?.() ?? new Date();
  // The match is keyed on exactly what the model sees of the profile (skills, education, facts).
  // Preferences (locations, tier cutoffs) and writing style are applied fresh on every run below,
  // so changing them re-scores without a model call.
  const profileHash = shortHash(profileForModel(profile));
  const report: ScoringReport = { considered: 0, passed: 0, dropped: 0, modelCalls: 0, reused: 0 };
  // Once the subscription's usage limit is hit, the rest use keywords (upgraded on a later run).
  let limited = false;
  await mapLimit(store.openPostings(), opts.concurrency ?? 4, async (posting) => {
    report.considered++;
    const hash = shortHash(
      profileHash,
      posting.title,
      posting.descriptionText ?? "",
      posting.locations.join("|"),
    );
    const filter = applyHardFilters(posting, profile);
    if (!filter.pass) {
      store.saveScore(posting.id, false, filter.reasons, null, hash);
      report.dropped++;
      return;
    }
    const prev = store.getScore(posting.id);
    let match: RequirementMatch;
    // A keyword match saved by an offline run is upgraded once a model is available.
    const upgrade = llm && posting.descriptionText && prev?.fit?.match.method === "keywords";
    if (prev?.fit && prev.input_hash === hash && !upgrade) {
      match = prev.fit.match;
      report.reused++;
    } else if (llm && posting.descriptionText && !limited) {
      try {
        match = await matchRequirements(llm, posting, profile);
        report.modelCalls++;
      } catch (e) {
        if (e instanceof UsageLimitError) {
          if (!limited) deps.log?.(`${e.message} Using keyword matches for the rest of this run.`);
          limited = true;
        } else {
          deps.log?.(`requirement match failed for ${posting.id}, using keywords: ${String(e)}`);
        }
        match = keywordRequirementMatch(posting, profile);
      }
    } else {
      match = keywordRequirementMatch(posting, profile);
    }
    store.saveScore(posting.id, true, [], computeFitScore(posting, profile, match, now), hash);
    report.passed++;
  });
  return report;
}

/** The list-style wording for a stored sponsorship value, so re-detection can only get stricter. */
const SPONSORSHIP_FLAG: Record<Posting["sponsorship"], string | null> = {
  unknown: null,
  offers: "Offers Sponsorship",
  no_sponsorship: "Does Not Offer Sponsorship",
  citizenship_required: "U.S. Citizenship is Required",
};

export interface EnrichReport {
  tried: number;
  enriched: number;
  failed: number;
}

/**
 * Fetch descriptions (and Greenhouse forms) for the best-scoring postings that lack them,
 * so the next scoring pass can judge skills. Capped per run to stay polite to each API.
 */
export async function runEnrichment(
  deps: PipelineDeps,
  opts: { limit?: number; limiter?: HostRateLimiter } = {},
): Promise<EnrichReport> {
  const { store } = deps;
  const http = {
    fetch: deps.fetch,
    limiter: opts.limiter ?? new HostRateLimiter(1000),
    retries: 1,
  };
  const todo = store
    .rankedCandidates(5000)
    .map((r) => r.posting)
    .filter((p) => canEnrich(p) && (!p.descriptionText || (p.ats === "greenhouse" && !p.questions)))
    .slice(0, opts.limit ?? 150);
  const report: EnrichReport = { tried: todo.length, enriched: 0, failed: 0 };
  const ashbyCache = new Map();
  // Workday turns automated clients away with HTTP 429. Once it does, leave it alone this run
  // rather than retrying every posting (the description is only needed for scoring).
  let workdayRefused = false;
  for (const p of todo) {
    if (p.ats === "workday" && workdayRefused) continue;
    try {
      const d = await fetchPostingDetail(p, http, ashbyCache);
      if (!d) continue;
      store.savePostings([
        {
          ...p,
          descriptionText: d.descriptionText ?? p.descriptionText,
          questions: d.questions ?? p.questions,
          locations: p.locations.length ? p.locations : (d.locations ?? []),
          terms: p.terms.length ? p.terms : detectTerms(d.descriptionText ?? ""),
          deadline: d.deadline ?? p.deadline,
          sponsorship: detectSponsorship(SPONSORSHIP_FLAG[p.sponsorship], d.descriptionText),
        },
      ]);
      report.enriched++;
    } catch (e) {
      report.failed++;
      if (p.ats === "workday" && /HTTP 429/.test(String(e))) {
        workdayRefused = true;
        deps.log?.(
          "Workday is refusing automated requests (HTTP 429); skipping Workday details this run",
        );
        continue;
      }
      deps.log?.(`could not fetch details for ${p.id}: ${String(e)}`);
    }
  }
  return report;
}
