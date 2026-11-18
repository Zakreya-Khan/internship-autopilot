// Interview story bank: STAR stories (situation, task, action, result) built only from profile
// facts. Every number in a story must appear in a fact it cites. Field names and the number
// provenance rule adapted from career-ops (MIT, see NOTICE): lib/story-bank.mjs and
// story-provenance-check.mjs.
import type { IndexedFact, Profile } from "./profile.ts";
import { indexFacts } from "./profile.ts";
import { checkWriting, profileOwnWords } from "./writing.ts";

export interface StarStory {
  title: string;
  situation: string;
  task: string;
  action: string;
  result: string;
  /** Interview questions it answers, e.g. "a hard bug", "working with ambiguity". */
  bestFor: string[];
  factIds: string[];
}

export interface StoryIssue {
  story: string;
  problem: string;
}

const SPELLED: Record<string, string> = {
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
  twenty: "20",
  thirty: "30",
  fifty: "50",
  hundred: "100",
  thousand: "1000",
};

/** Numbers as canonical strings: thousands separators dropped, k/M expanded, spelled numbers turned to digits. */
export function storyNumbers(text: string): string[] {
  const out: string[] = [];
  const t = text.replace(/(\d),(?=\d{3}\b)/g, "$1");
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*([kKmM])?\b/g)) {
    let n = Number(m[1]);
    if (m[2]) n *= /k/i.test(m[2]) ? 1000 : 1_000_000;
    out.push(String(n));
  }
  for (const m of t.toLowerCase().matchAll(/\b([a-z]+)\b/g))
    if (SPELLED[m[1]!]) out.push(SPELLED[m[1]!]!);
  return out;
}

function isYear(n: string): boolean {
  return /^(19|20)\d\d$/.test(n);
}

/**
 * Code checks for one story: it cites only real facts, every number in it appears in a cited
 * fact (or its verified number), and it follows the writing rules.
 */
export function checkStory(
  profile: Profile,
  s: StarStory,
  facts = indexFacts(profile),
): StoryIssue[] {
  const issues: StoryIssue[] = [];
  const unknown = s.factIds.filter((id) => !facts.has(id));
  if (unknown.length)
    issues.push({ story: s.title, problem: `cites unknown facts: ${unknown.join(", ")}` });
  const cited = s.factIds.map((id) => facts.get(id)).filter((f): f is IndexedFact => Boolean(f));
  if (!cited.length) issues.push({ story: s.title, problem: "cites no facts" });
  if (!s.action.trim()) issues.push({ story: s.title, problem: "has no action" });
  const allowed = new Set(
    cited.flatMap((f) => [...storyNumbers(f.text), ...storyNumbers(f.verifiedMetric ?? "")]),
  );
  const body = [s.title, s.situation, s.task, s.action, s.result].join("\n");
  const numbers = new Set(storyNumbers(body).filter((n) => !isYear(n)));
  for (const n of numbers)
    if (!allowed.has(n))
      issues.push({ story: s.title, problem: `the number ${n} isn't in the facts it cites` });
  // Your own wording (a banned word or a dash you wrote in a fact) isn't held against a story.
  const own = profileOwnWords(profile);
  for (const w of checkWriting([{ where: s.title, text: body }], own))
    if (!(w.rule === "em_dash" && own.includes(w.match)))
      issues.push({ story: s.title, problem: w.problem });
  return issues;
}

/**
 * Stories with no model: one per experience or project, in your own fact wording. The result
 * is the fact that carries a verified number, if any. Nothing is added.
 */
export function storiesFromFacts(profile: Profile): StarStory[] {
  const out: StarStory[] = [];
  const entries = [
    ...profile.experience.map((e) => ({ id: e.id, name: `${e.title}, ${e.org}`, facts: e.facts })),
    ...profile.projects.map((p) => ({ id: p.id, name: p.name, facts: p.facts })),
  ];
  for (const e of entries) {
    if (!e.facts.length) continue;
    const withMetric = e.facts.find((f) => f.verified_metric);
    const actions = e.facts.filter((f) => f !== withMetric);
    out.push({
      title: e.name,
      situation: e.name,
      task: "",
      action: (actions.length ? actions : e.facts).map((f) => f.text).join(". "),
      result: withMetric?.text ?? "",
      bestFor: [],
      factIds: e.facts.map((f) => f.id),
    });
  }
  return out.slice(0, 10);
}

/** Markdown for data/stories.md (gitignored; it holds your own facts). */
export function storiesMarkdown(stories: StarStory[], issues: StoryIssue[]): string {
  const lines = [
    "# Interview story bank",
    "",
    "Built only from facts in profile.yaml. Practice saying these; don't read them.",
    "",
  ];
  for (const s of stories) {
    const own = issues.filter((i) => i.story === s.title);
    lines.push(`### ${s.title}`);
    if (s.situation) lines.push(`**S (Situation):** ${s.situation}`);
    if (s.task) lines.push(`**T (Task):** ${s.task}`);
    lines.push(`**A (Action):** ${s.action}`);
    if (s.result) lines.push(`**R (Result):** ${s.result}`);
    if (s.bestFor.length) lines.push(`**Best for questions about:** ${s.bestFor.join("; ")}`);
    lines.push(`**Facts:** ${s.factIds.join(", ")}`);
    if (own.length) lines.push(`**Check before using:** ${own.map((i) => i.problem).join("; ")}`);
    lines.push("");
  }
  return lines.join("\n");
}
