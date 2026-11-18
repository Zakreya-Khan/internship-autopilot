// Work shared by the CLI commands and the review UI's background jobs, so both do exactly the same.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Posting, Profile, StarStory, StoryIssue } from "@ia/core";
import { checkClaims, checkStory, checkWriting, profileOwnWords, storiesFromFacts } from "@ia/core";
import { storiesMarkdown } from "@ia/core";
import type { LlmClient } from "@ia/ai";
import { draftOutreach, draftStories, OUTREACH_MAX_CHARS } from "@ia/ai";
import type { LivenessResult } from "@ia/sources";
import type { Store } from "./db.ts";
import type { LivenessCheck } from "./liveness.ts";
import { ensureOpen } from "./liveness.ts";

export interface OpenCheckRow {
  postingId: string;
  company: string;
  title: string;
  verdict: LivenessResult["verdict"];
  code: string;
  reason: string;
  via: string;
}

/** Ask each posting's job board whether it is still open. Closed ones are recorded for good. */
export async function checkOpenPostings(
  store: Store,
  postings: Posting[],
  check: LivenessCheck,
  opts: {
    signal?: AbortSignal;
    progress?: (done: number, total: number, note?: string) => void;
  } = {},
): Promise<{ rows: OpenCheckRow[]; active: number; expired: number; uncertain: number }> {
  const out = { rows: [] as OpenCheckRow[], active: 0, expired: 0, uncertain: 0 };
  for (const [i, p] of postings.entries()) {
    if (opts.signal?.aborted) break;
    opts.progress?.(i, postings.length, `${p.company}: ${p.title}`);
    const r = await ensureOpen(store, p, check, 0);
    out[r.verdict]++;
    out.rows.push({
      postingId: p.id,
      company: p.company,
      title: p.title,
      verdict: r.verdict,
      code: r.code,
      reason: r.reason,
      via: r.via,
    });
  }
  return out;
}

export interface StoriesResult {
  stories: StarStory[];
  issues: StoryIssue[];
  /** How many stories have something to check. */
  flagged: number;
  path: string;
  markdown: string;
  /** False when written without a model: one story per entry, in your own words. */
  drafted: boolean;
}

/** The interview story bank, written to data/stories.md. Every number must appear in a cited fact. */
export async function writeStories(
  profile: Profile,
  llm: LlmClient | null,
  home: string,
  count = 8,
): Promise<StoriesResult> {
  const stories = llm ? await draftStories(llm, profile, count) : storiesFromFacts(profile);
  const issues = stories.flatMap((s) => checkStory(profile, s));
  const markdown = storiesMarkdown(stories, issues);
  mkdirSync(home, { recursive: true });
  const path = join(home, "stories.md");
  writeFileSync(path, markdown);
  return {
    stories,
    issues,
    flagged: new Set(issues.map((i) => i.story)).size,
    path,
    markdown,
    drafted: Boolean(llm),
  };
}

export interface OutreachResult {
  kind: "recruiter" | "referral";
  company: string;
  title: string;
  message: string;
  /** Fix these before sending. */
  problems: string[];
}

/** A short message for you to send yourself. Never sent; no LinkedIn. */
export async function outreachDraft(
  llm: LlmClient,
  profile: Profile,
  posting: Posting,
  kind: "recruiter" | "referral",
): Promise<OutreachResult> {
  const d = await draftOutreach(llm, profile, posting, kind);
  const problems = [
    ...checkClaims(profile, [
      {
        where: "message",
        text: d.message,
        factIds: d.factIds,
        mustCite: false,
        context: `${posting.company}\n${posting.title}`,
      },
    ])
      .filter((i) => i.severity === "block")
      .map((i) => i.problem),
    ...checkWriting([{ where: "message", text: d.message }], profileOwnWords(profile)).map(
      (w) => w.problem,
    ),
    ...(d.message.length > OUTREACH_MAX_CHARS
      ? [`${d.message.length} characters; trim to ${OUTREACH_MAX_CHARS}`]
      : []),
  ];
  return { kind, company: posting.company, title: posting.title, message: d.message, problems };
}
