import { canonicalizeUrl, parseAtsUrl, postingId } from "./ats.ts";
import { classifyRoleFamily } from "./classify.ts";
import { normalizeCompany, normalizeTitle, similarity } from "./text.ts";
import type { Posting, RawPosting } from "./types.ts";

export const TITLE_SIMILARITY_THRESHOLD = 0.9;

/** Give a raw posting its id, canonical links and timestamps. */
export function finalizePosting(raw: RawPosting, now: string): Posting {
  const applyUrl = canonicalizeUrl(raw.applyUrl);
  const ref = parseAtsUrl(applyUrl);
  const ats = raw.ats !== "other" ? raw.ats : ref.ats;
  const boardToken = raw.boardToken ?? ref.boardToken;
  const atsJobId = raw.atsJobId ?? ref.jobId;
  return {
    ...raw,
    applyUrl,
    ats,
    boardToken,
    atsJobId,
    id: postingId({ ats, boardToken, jobId: atsJobId }, applyUrl),
    sourceLinks: [...new Set(raw.sourceLinks.map(canonicalizeUrl))],
    roleFamily: raw.roleFamily ?? classifyRoleFamily(raw.title, raw.category),
    questions: raw.questions ?? null,
    firstSeen: now,
    lastSeen: now,
    missedPolls: 0,
  };
}

function locationsOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  const norm = (s: string) => s.toLowerCase().split(",")[0]!.trim();
  const A = new Set(a.map(norm));
  return b.some((x) => A.has(norm(x)));
}

/** Same role? Same id, or same company with near-identical titles and overlapping locations. */
export function isSameRole(a: Posting, b: Posting): boolean {
  if (a.id === b.id) return true;
  if (a.atsJobId && b.atsJobId && a.ats === b.ats && a.atsJobId === b.atsJobId) {
    // Same ATS job id; board tokens may be missing on one side (e.g. a `gh_jid` link).
    if (
      !a.boardToken ||
      !b.boardToken ||
      a.boardToken.toLowerCase() === b.boardToken.toLowerCase()
    ) {
      return true;
    }
  }
  if (normalizeCompany(a.company) !== normalizeCompany(b.company)) return false;
  return (
    similarity(normalizeTitle(a.title), normalizeTitle(b.title)) >= TITLE_SIMILARITY_THRESHOLD &&
    locationsOverlap(a.locations, b.locations)
  );
}

const SOURCE_RANK: Record<string, number> = {
  greenhouse: 3,
  lever: 3,
  ashby: 3,
  simplify: 2,
  manual: 1,
};

function bestSource(p: Posting): number {
  return Math.max(0, ...p.sources.map((s) => SOURCE_RANK[s] ?? 0));
}

/** Merge two records of one role. API data beats list data; every link is kept. */
export function mergePostings(existing: Posting, incoming: Posting): Posting {
  const preferIncoming = bestSource(incoming) > bestSource(existing);
  const primary = preferIncoming ? incoming : existing;
  const secondary = preferIncoming ? existing : incoming;
  return {
    ...secondary,
    ...primary,
    id: existing.id,
    sources: [...new Set([...existing.sources, ...incoming.sources])],
    sourceLinks: [
      ...new Set([...existing.sourceLinks, ...incoming.sourceLinks, incoming.applyUrl]),
    ],
    descriptionText: primary.descriptionText ?? secondary.descriptionText,
    questions: primary.questions ?? secondary.questions,
    locations: primary.locations.length ? primary.locations : secondary.locations,
    terms: [...new Set([...existing.terms, ...incoming.terms])],
    degrees: primary.degrees.length ? primary.degrees : secondary.degrees,
    sponsorship: stricterSponsorship(existing.sponsorship, incoming.sponsorship),
    deadline: primary.deadline ?? secondary.deadline,
    postedAt: earliest(existing.postedAt, incoming.postedAt),
    firstSeen: existing.firstSeen < incoming.firstSeen ? existing.firstSeen : incoming.firstSeen,
    lastSeen: existing.lastSeen > incoming.lastSeen ? existing.lastSeen : incoming.lastSeen,
    isOpen: incoming.isOpen,
    missedPolls: 0,
  };
}

function earliest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

const SPONSOR_STRICTNESS = {
  unknown: 0,
  offers: 1,
  no_sponsorship: 2,
  citizenship_required: 3,
} as const;

function stricterSponsorship(
  a: Posting["sponsorship"],
  b: Posting["sponsorship"],
): Posting["sponsorship"] {
  return SPONSOR_STRICTNESS[a] >= SPONSOR_STRICTNESS[b] ? a : b;
}

export interface MergeResult {
  postings: Posting[];
  added: number;
  merged: number;
}

/**
 * Fold incoming postings into the existing set.
 * Exact id matches are found in O(1); the fuzzy pass only compares within one company.
 */
export function upsertAll(existing: Posting[], incoming: Posting[]): MergeResult {
  const byId = new Map(existing.map((p) => [p.id, p]));
  const byCompany = new Map<string, Posting[]>();
  for (const p of existing) {
    const k = normalizeCompany(p.company);
    byCompany.set(k, [...(byCompany.get(k) ?? []), p]);
  }
  let added = 0;
  let merged = 0;
  for (const inc of incoming) {
    const companyKey = normalizeCompany(inc.company);
    const match =
      byId.get(inc.id) ?? (byCompany.get(companyKey) ?? []).find((p) => isSameRole(p, inc));
    if (match) {
      const m = mergePostings(match, inc);
      byId.set(m.id, m);
      byCompany.set(
        companyKey,
        (byCompany.get(companyKey) ?? []).map((p) => (p.id === m.id ? m : p)),
      );
      merged++;
    } else {
      byId.set(inc.id, inc);
      byCompany.set(companyKey, [...(byCompany.get(companyKey) ?? []), inc]);
      added++;
    }
  }
  return { postings: [...byId.values()], added, merged };
}

/** After an API poll: anything from that board not seen this time gets a strike; two strikes closes it. */
export function markMissing(
  postings: Posting[],
  seenIds: Set<string>,
  boardKey: (p: Posting) => boolean,
): Posting[] {
  return postings.map((p) => {
    if (!boardKey(p) || seenIds.has(p.id)) return p;
    const missedPolls = p.missedPolls + 1;
    return { ...p, missedPolls, isOpen: missedPolls >= 2 ? false : p.isOpen };
  });
}
