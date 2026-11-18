// Long work started from the review UI (find postings, check open, prep, batches, stories,
// outreach, email sync) runs here, in the server, one job per lane at a time. The UI polls a
// job for progress and its result. Jobs never submit anything and never type into a form.
import type { Profile, Tier } from "@ia/core";
import type { BatchClient, LlmClient } from "@ia/ai";
import { MODELS } from "@ia/ai";
import type { FetchFn } from "@ia/sources";
import type { CoverLetterBase, VoiceTraits } from "@ia/core";
import { checkOpenPostings, outreachDraft, writeStories } from "./actions.ts";
import type { Store } from "./db.ts";
import type { LivenessCheck } from "./liveness.ts";
import { runEnrichment, runScoring, runSourcing } from "./pipeline.ts";
import type { PrepDeps } from "./prep.ts";
import { runPrep } from "./prep.ts";
import type { Provider } from "./provider.ts";

export const JOB_KINDS = [
  "refresh",
  "check-open",
  "prep",
  "batch-submit",
  "batch-collect",
  "batch-cancel",
  "stories",
  "outreach",
  "email-sync",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export function isJobKind(x: unknown): x is JobKind {
  return typeof x === "string" && (JOB_KINDS as readonly string[]).includes(x);
}

/** Jobs in the same lane would step on each other (both write postings or applications). */
const LANE: Record<JobKind, "pipeline" | "writing"> = {
  refresh: "pipeline",
  "check-open": "pipeline",
  prep: "pipeline",
  "batch-submit": "pipeline",
  "batch-collect": "pipeline",
  "batch-cancel": "pipeline",
  "email-sync": "pipeline",
  stories: "writing",
  outreach: "writing",
};

export const JOB_LABELS: Record<JobKind, string> = {
  refresh: "Find postings",
  "check-open": "Check which postings are open",
  prep: "Prepare applications",
  "batch-submit": "Send Tier B to the Batch API",
  "batch-collect": "Collect finished batches",
  "batch-cancel": "Cancel open batches",
  stories: "Write interview stories",
  outreach: "Draft an outreach message",
  "email-sync": "Update statuses from email",
};

export type JobStatus = "running" | "done" | "failed" | "cancelled";

export interface JobView {
  id: number;
  kind: JobKind;
  label: string;
  status: JobStatus;
  startedAt: string;
  finishedAt: string | null;
  progress: { done: number; total: number; note: string | null } | null;
  /** Warnings and notes from the run, newest last (at most 200). */
  log: string[];
  /** One plain sentence on what happened. */
  summary: string | null;
  result: unknown;
  error: string | null;
}

/** What jobs need from the running server. Getters, because Settings can change the provider. */
export interface JobContext {
  store: Store;
  profile: () => Profile;
  llm: () => LlmClient | null;
  provider: () => Provider;
  /** Why there is no model, when llm() is null. */
  llmReason: () => string | null;
  fetch: FetchFn;
  outDir: string;
  /** data/: stories.md is written here. */
  home: string;
  /** Null: no open check (tests). */
  liveness: () => LivenessCheck | null;
  /** The Message Batches client (needs an API key). */
  batchClient?: () => BatchClient;
  voice?: VoiceTraits | null;
  coverBase?: CoverLetterBase | null;
  now?: () => Date;
}

export class JobConflict extends Error {}

/** Thrown by a job for a plain-language failure (shown as is). */
export class JobProblem extends Error {}

interface Running {
  view: JobView;
  abort: AbortController;
}

type Params = Record<string, unknown>;
type Tools = {
  signal: AbortSignal;
  progress: (done: number, total: number, note?: string) => void;
  log: (msg: string) => void;
};
type Outcome = { summary: string; result?: unknown };

const MAX_KEPT = 30;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export class JobRunner {
  private jobs: Running[] = [];
  private nextId = 1;

  constructor(private readonly ctx: JobContext) {}

  list(): JobView[] {
    return this.jobs.map((j) => j.view).toReversed();
  }

  get(id: number): JobView | null {
    return this.jobs.find((j) => j.view.id === id)?.view ?? null;
  }

  running(): JobView[] {
    return this.jobs.filter((j) => j.view.status === "running").map((j) => j.view);
  }

  /** Start a job, or refuse with JobConflict when one in the same lane is running. */
  start(kind: JobKind, params: Params = {}): JobView {
    const clash = this.running().find((j) => LANE[j.kind] === LANE[kind]);
    if (clash)
      throw new JobConflict(
        `"${clash.label}" is still running. Wait for it to finish, or cancel it first.`,
      );
    const view: JobView = {
      id: this.nextId++,
      kind,
      label: JOB_LABELS[kind],
      status: "running",
      startedAt: this.now().toISOString(),
      finishedAt: null,
      progress: null,
      log: [],
      summary: null,
      result: null,
      error: null,
    };
    const abort = new AbortController();
    this.jobs.push({ view, abort });
    this.jobs = this.jobs.slice(-MAX_KEPT);
    const tools: Tools = {
      signal: abort.signal,
      progress: (done, total, note) => {
        view.progress = { done: Math.min(done, total), total, note: note ?? null };
      },
      log: (msg) => {
        view.log.push(msg);
        if (view.log.length > 200) view.log.shift();
      },
    };
    void this.run(kind, params, tools).then(
      (o) => {
        view.status = abort.signal.aborted ? "cancelled" : "done";
        view.summary = abort.signal.aborted ? `Cancelled. ${o.summary}` : o.summary;
        view.result = o.result ?? null;
        view.finishedAt = this.now().toISOString();
      },
      (e: unknown) => {
        view.status = "failed";
        view.error = plainError(e);
        view.finishedAt = this.now().toISOString();
      },
    );
    return view;
  }

  /** Ask a running job to stop. It stops between items; what it finished is kept. */
  cancel(id: number): JobView | null {
    const j = this.jobs.find((x) => x.view.id === id);
    if (!j) return null;
    if (j.view.status === "running") j.abort.abort();
    return j.view;
  }

  /** Resolves when every running job has finished (tests). */
  async idle(): Promise<void> {
    while (this.running().length) await new Promise((r) => setTimeout(r, 5));
  }

  private now(): Date {
    return this.ctx.now?.() ?? new Date();
  }

  private prepDeps(t: Tools, opts: { sonnet?: boolean; skipOpenCheck?: boolean } = {}): PrepDeps {
    const c = this.ctx;
    return {
      store: c.store,
      profile: c.profile(),
      fetch: c.fetch,
      llm: c.llm(),
      outDir: c.outDir,
      log: t.log,
      signal: t.signal,
      progress: t.progress,
      liveness: opts.skipOpenCheck ? null : c.liveness(),
      voice: c.voice ?? null,
      coverBase: c.coverBase ?? null,
      ...(c.now ? { now: c.now } : {}),
      ...(opts.sonnet ? { tierBModel: MODELS.sonnet } : {}),
    };
  }

  private batchClient(): BatchClient {
    if (this.ctx.provider() === "cli")
      throw new JobProblem(
        "The Batch API needs your Anthropic API key. You're using the Claude CLI: switch in Settings.",
      );
    if (!this.ctx.llm() || !this.ctx.batchClient)
      throw new JobProblem(
        `The Batch API needs an Anthropic API key (${this.ctx.llmReason() ?? "none set"}). Add one in Settings.`,
      );
    return this.ctx.batchClient();
  }

  private async run(kind: JobKind, p: Params, t: Tools): Promise<Outcome> {
    const c = this.ctx;
    switch (kind) {
      case "refresh": {
        const useModel = p.useModel !== false;
        const deps = { ...this.prepDeps(t), ...(useModel ? {} : { llm: null }) };
        if (useModel && !deps.llm) t.log(`No Claude (${c.llmReason()}): keyword scoring.`);
        const company = typeof p.company === "string" ? p.company : undefined;
        const src = await runSourcing(deps, {
          includeSimplify: p.simplify !== false,
          includeWatchlist: p.watchlist !== false,
          ...(company ? { company } : {}),
        });
        for (const e of src.errors) t.log(`source problem: ${e}`);
        if (t.signal.aborted) return { summary: sourcingLine(src), result: { sourcing: src } };
        const scored = await runScoring(deps);
        const enriched = t.signal.aborted ? null : await runEnrichment(deps);
        const rescored = t.signal.aborted ? null : await runScoring(deps);
        return {
          summary: [
            sourcingLine(src),
            `${plural((rescored ?? scored).passed, "posting")} pass your filters.`,
            enriched ? `Details fetched for ${enriched.enriched} of ${enriched.tried}.` : "",
          ]
            .filter(Boolean)
            .join(" "),
          result: { sourcing: src, scoring: rescored ?? scored, enrichment: enriched },
        };
      }
      case "check-open": {
        const check = c.liveness();
        if (!check) throw new JobProblem("Open checks are turned off for this server.");
        const ids = Array.isArray(p.postingIds) ? p.postingIds.map(String) : null;
        const postings = ids
          ? ids.map((id) => c.store.getPosting(id)).filter((x) => x !== null)
          : c.store.rankedCandidates(Number(p.limit ?? 25)).map((r) => r.posting);
        const r = await checkOpenPostings(c.store, postings, check, t);
        return {
          summary: `${r.active} open, ${r.expired} closed (recorded; they won't come back), ${r.uncertain} unclear (kept).`,
          result: r,
        };
      }
      case "prep": {
        const deps = this.prepDeps(t, {
          sonnet: p.sonnet === true,
          skipOpenCheck: p.skipOpenCheck === true,
        });
        if (!deps.llm)
          t.log(`No Claude (${c.llmReason()}): base resume only, open questions left for you.`);
        const ids = Array.isArray(p.postingIds) ? p.postingIds.map(String) : undefined;
        const tiers = Array.isArray(p.tiers) ? (p.tiers as Tier[]) : undefined;
        const r = await runPrep(deps, {
          ...(ids ? { postingIds: ids } : { limit: Number(p.limit ?? 5) }),
          ...(tiers ? { tiers } : {}),
        });
        if (r.busy) throw new JobProblem(`Nothing done: ${r.stopped}. Try again when it finishes.`);
        const line = `Prepared ${r.prepared}: ${r.ready} ready, ${r.needsInput} need your input, ${r.failed} failed, ${r.closed} skipped as closed.`;
        return {
          summary:
            r.stopped && !t.signal.aborted
              ? `${line} Stopped early: ${r.stopped}${r.paused ? " Try again after it resets." : ""}`
              : line,
          result: r,
        };
      }
      case "batch-submit": {
        const limit = Number(p.limit ?? 100);
        if (c.provider() === "cli") {
          // The CLI has no Batch API: prepare Tier B one at a time, as `batch` does in the CLI.
          t.log(
            "The Claude CLI has no Batch API, so Tier B is prepared one at a time instead. Switch to your API key in Settings for half-price batches.",
          );
          const r = await runPrep(this.prepDeps(t), { limit, tiers: ["B"] });
          if (r.busy)
            throw new JobProblem(`Nothing done: ${r.stopped}. Try again when it finishes.`);
          return {
            summary: `No batch on the Claude CLI: prepared ${r.prepared} Tier B one at a time (${r.ready} ready, ${r.needsInput} need input).`,
            result: r,
          };
        }
        const { submitPrepBatch } = await import("./batch.ts");
        const r = await submitPrepBatch(this.prepDeps(t), this.batchClient(), { limit });
        return {
          summary: r.batchId
            ? `Sent ${plural(r.count, "Tier B draft")} as one batch. Results come back within 24 hours; then press Collect.`
            : "Nothing to batch: no unprepared Tier B postings.",
          result: r,
        };
      }
      case "batch-collect": {
        const { collectPrepBatches } = await import("./batch.ts");
        const r = await collectPrepBatches(this.prepDeps(t), this.batchClient());
        return {
          summary: r.batches
            ? `${plural(r.batches, "open batch", "open batches")}: ${r.completed} finished, ${r.pending} still running, ${r.failed} failed.`
            : "No open batches.",
          result: r,
        };
      }
      case "batch-cancel": {
        const { cancelPrepBatches } = await import("./batch.ts");
        const r = await cancelPrepBatches(this.prepDeps(t), this.batchClient());
        return {
          summary: r.cancelled
            ? `Cancelled ${plural(r.cancelled, "batch", "batches")}. Press Collect once they end; anything unfinished is prepared live next time.`
            : "No running batches to cancel.",
          result: r,
        };
      }
      case "stories": {
        const llm = c.llm();
        if (!llm) t.log(`No Claude (${c.llmReason()}): one story per entry, in your own words.`);
        t.progress(0, 1, "Writing");
        const r = await writeStories(c.profile(), llm, c.home, Number(p.count ?? 8));
        return {
          summary: `Wrote ${plural(r.stories.length, "story", "stories")} to data/stories.md; ${r.flagged} need checking.`,
          result: { markdown: r.markdown, flagged: r.flagged, count: r.stories.length },
        };
      }
      case "outreach": {
        const llm = c.llm();
        if (!llm) throw new JobProblem(`Outreach drafts need Claude (${c.llmReason()}).`);
        const posting = c.store.getPosting(String(p.postingId ?? ""));
        if (!posting) throw new JobProblem("That posting isn't in the database any more.");
        t.progress(0, 1, `${posting.company}: ${posting.title}`);
        const r = await outreachDraft(
          llm,
          c.profile(),
          posting,
          p.to === "referral" ? "referral" : "recruiter",
        );
        return {
          summary: r.problems.length
            ? `Draft ready, with ${plural(r.problems.length, "thing")} to fix before you send it.`
            : "Draft ready. It isn't sent: copy it if you want it.",
          result: r,
        };
      }
      case "email-sync": {
        const path = String(p.path ?? "").trim();
        if (!path)
          throw new JobProblem("Give the path of an .mbox file or a folder of .eml files.");
        const { syncEmails } = await import("./email-sync.ts");
        let r;
        try {
          r = syncEmails(c.store, path, { dryRun: p.dryRun === true });
        } catch (e) {
          throw new JobProblem(`Couldn't read ${path}: ${plainError(e)}`);
        }
        return {
          summary: `${plural(r.read, "email")} read, ${r.matched} matched an application, ${plural(r.updated.length, "status change")}${p.dryRun === true ? " (dry run: nothing saved)" : ""}.`,
          result: r,
        };
      }
    }
  }
}

function sourcingLine(s: { added: number; merged: number; closed: number; fetched: number }) {
  return `Read ${s.fetched} listings: ${plural(s.added, "new posting")}, ${s.merged} updated, ${s.closed} closed.`;
}

/** An error as a sentence a person can act on. */
export function plainError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/ENOTFOUND|EAI_AGAIN|fetch failed|ECONNREFUSED/i.test(msg))
    return "Couldn't reach the internet (or that site). Check your connection and try again.";
  if (/401|invalid x-api-key|authentication/i.test(msg))
    return "Claude rejected the API key. Check it in Settings.";
  if (/ENOENT/.test(msg)) return "That file or folder doesn't exist.";
  return msg.replace(/^Error:\s*/, "");
}
