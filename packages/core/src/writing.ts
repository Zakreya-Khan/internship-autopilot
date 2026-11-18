// Writing rules for every generated text: no stock AI vocabulary, no em dashes, no "not X but Y"
// reframes. Enforced in code, beside the truth check. Word lists adapted from career-ops
// (MIT, see NOTICE): cv-voice.mjs, modes/_writing.md and voice-dna.template.md. The reframe
// patterns are this project's own; career-ops only states that rule in its prompts.
import type { Profile } from "./profile.ts";
import { indexFacts } from "./profile.ts";

/**
 * Words and phrases that mark text as machine-written. Technical words with a real meaning in a
 * resume ("optimize", "scalable", "robust", "predictive") are left off on purpose. Any entry
 * that already appears in your own profile text is allowed: your words are never flagged.
 */
export const BANNED_PHRASES = [
  // career-ops cv-voice.mjs
  "passionate about",
  "results-oriented",
  "results-driven",
  "proven track record",
  "leveraged",
  "leveraging",
  "leverage",
  "spearheaded",
  "spearheading",
  "spearhead",
  "facilitated",
  "facilitating",
  "synergies",
  "synergy",
  "cutting-edge",
  "in today's fast-paced world",
  "demonstrated ability to",
  "best practices",
  "significant impact",
  "measurable impact",
  "orchestrated",
  "championed",
  "utilized",
  "utilize",
  "utilizing",
  "delve",
  "delving",
  "tapestry",
  "pivotal",
  // voice-dna dead vocabulary, minus words with a plain technical sense
  "realm",
  "harness",
  "harnessing",
  "unlock",
  "unlocking",
  "paradigm",
  "revolutionize",
  "revolutionizing",
  "showcase",
  "showcasing",
  "crucial",
  "meticulous",
  "meticulously",
  "vibrant",
  "unparalleled",
  "underscore",
  "underscores",
  "underscoring",
  "innovative",
  "game-changer",
  "game-changing",
  "testament",
  "commendable",
  "groundbreaking",
  "foster",
  "fostering",
  "holistic",
  "garner",
  "accentuate",
  "pioneering",
  "trailblazing",
  "unleash",
  "transformative",
  "redefine",
  "seamless",
  "seamlessly",
  "empower",
  "empowering",
  "streamline",
  "streamlined",
  "frictionless",
  "elevate",
  "elevating",
  "effortless",
  "insightful",
  "visionary",
  "disruptive",
  "reimagine",
  "unprecedented",
  "supercharge",
  "future-proof",
  "state-of-the-art",
  "interplay",
  "captivate",
  "captivated",
  // dead phrases, transitions and filler
  "it's important to note",
  "it is important to note",
  "it's worth noting",
  "it is worth noting",
  "at the end of the day",
  "moving forward",
  "in other words",
  "it goes without saying",
  "let's dive in",
  "dive into",
  "deep dive",
  "furthermore",
  "moreover",
  "additionally",
  "that being said",
  "with that in mind",
  "on top of that",
  "let that sink in",
  "this changes everything",
  "i'd be happy to",
  "i hope this helps",
  "thrilled to",
  "i am confident that",
  "i'm confident that",
  "unique blend",
  "wealth of experience",
  "fast-paced environment",
  "hit the ground running",
  "make a meaningful impact",
  "eager to contribute",
] as const;

export type WritingRule = "banned_phrase" | "em_dash" | "reframe";

export interface WritingIssue {
  where: string;
  rule: WritingRule;
  /** The offending text, as it appears. */
  match: string;
  problem: string;
}

/** Fold typographic punctuation so a phrase matches however it was typed. */
export function foldWording(text: string): string {
  return text
    .replace(/[\u2010-\u2012\u2212]/g, "-")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/\u00A0/g, " ");
}

function phraseRegex(phrase: string): RegExp {
  const body = phrase
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/-/g, "(?:\\s*-\\s*|\\s+)")
    .replace(/ /g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "iu");
}

/** "leverage" and "leveraging" are one word for reporting purposes. */
function sameWord(a: string, b: string): boolean {
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return l.startsWith(s.replace(/e$/, ""));
}
const PHRASE_RES = BANNED_PHRASES.map((p) => [p, phraseRegex(p)] as const);

/**
 * "Not X but Y" and its cousins: a sentence that knocks down one framing to assert another.
 * Each pattern stays inside one sentence (no . ! ? between its parts) or spans exactly two.
 */
export const REFRAME_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "not only X but also Y", re: /\bnot only\b[^.!?]{1,100}?\bbut(?: also)?\b/i },
  {
    name: "not X, but Y",
    re: /\bnot (?:just |merely |simply |only )?(?:about |a |an |the )?[^.!?,;]{1,40},? but (?:rather |instead )?(?:a |an |the |about |to |as |in |for )/i,
  },
  {
    name: "it's not (just) X, it's Y",
    re: /\b(?:it|this|that)(?:'s| is| was)\s+not\s+(?:just\s+|only\s+|merely\s+)?(?:about\s+)?[^.!?]{1,60}[.;,:]\s*(?:it|this|that)(?:'s| is| was)\b/i,
  },
  {
    name: "isn't X. It's Y",
    re: /\b(?:isn't|wasn't|is not|was not)\s+(?:just\s+|only\s+|merely\s+)?(?:about\s+)?[^.!?]{1,60}[.;,:]\s*(?:it|this|that)(?:'s| is| was)\b/i,
  },
  {
    name: "isn't just X",
    re: /\b(?:isn't|wasn't|is not|was not|not)\s+(?:just|merely|simply)\s+(?:about\s+)?(?:a|an|the|about|another)\b/i,
  },
  { name: "less X, more Y", re: /\bless\s+[^.!?,;]{1,30},\s*more\b/i },
  {
    name: "no X, no Y, just Z",
    re: /\bno\s+[^.!?,;]{1,25},\s*no\s+[^.!?,;]{1,25},\s*(?:just|only)\b/i,
  },
  { name: "X? No. Y", re: /\?\s*no[.!]\s/i },
];

const MONTH =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
/** "2025–2026", "2025 – May 2026", "2026–present" keep their dash. */
const DATE_RANGE_DASH = new RegExp(
  `((?:19|20)\\d{2})\\s*[\\u2013\\u2014]\\s*(?=(?:(?:${MONTH})\\b\\.?\\s+)?(?:(?:19|20)\\d{2}\\b|present\\b|current\\b|now\\b|today\\b))`,
  "giu",
);

/** Em dashes, and their stand-ins: an en dash, a spaced hyphen, or a double hyphen between words. */
function dashUses(text: string): string[] {
  const t = text.replace(DATE_RANGE_DASH, "$1 ");
  const out: string[] = [];
  for (const m of t.matchAll(/\S{0,12}\s*\u2014\s*\S{0,12}/g)) out.push(m[0].trim());
  // An en dash between two numbers is a range ("20–30"), which is fine.
  for (const m of t.matchAll(/(\S{0,12})\s*\u2013\s*(\S{0,12})/g))
    if (!(/\d$/.test(m[1]!) && /^\d/.test(m[2]!))) out.push(m[0].trim());
  for (const m of t.matchAll(/[\p{L}\p{N},)]+(?: -{1,2} | ?-- ?)[\p{L}\p{N}(]+/gu)) out.push(m[0]);
  return out;
}

export interface WritingCheckInput {
  where: string;
  text: string;
}

/**
 * Check generated text against the writing rules. `ownWords` is your own text (profile facts,
 * answer bank): a banned word you wrote yourself is not flagged when the draft repeats it.
 */
export function checkWriting(items: WritingCheckInput[], ownWords = ""): WritingIssue[] {
  const own = foldWording(ownWords);
  const allowed = new Set(PHRASE_RES.filter(([, re]) => re.test(own)).map(([p]) => p));
  const issues: WritingIssue[] = [];
  for (const { where, text } of items) {
    if (!text.trim()) continue;
    const t = foldWording(text);
    const seen = new Set<string>();
    for (const [phrase, re] of PHRASE_RES) {
      if (allowed.has(phrase)) continue;
      const m = re.exec(t);
      if (!m) continue;
      const key = m[0].toLowerCase();
      // "leverage" inside "leveraged" is the same hit; report it once.
      if ([...seen].some((s) => sameWord(s, key))) continue;
      seen.add(key);
      issues.push({
        where,
        rule: "banned_phrase",
        match: m[0],
        problem: `writing rule: "${m[0]}" reads as stock AI wording; say it plainly`,
      });
    }
    for (const d of dashUses(text)) {
      issues.push({
        where,
        rule: "em_dash",
        match: d,
        problem: `writing rule: dash in "${d}"; use a comma, period, colon or parentheses`,
      });
      break; // one dash note per text is enough
    }
    for (const { name, re } of REFRAME_PATTERNS) {
      const m = re.exec(t);
      if (!m) continue;
      issues.push({
        where,
        rule: "reframe",
        match: m[0].trim(),
        problem: `writing rule: "${m[0].trim()}" is a ${name} construction; state the point directly`,
      });
      break;
    }
  }
  return issues;
}

/** The rules as prompt text, so the model avoids them before code has to catch them. */
export function writingRulesPrompt(): string {
  const words = BANNED_PHRASES.filter((p) => !p.includes(" ")).join(", ");
  const phrases = BANNED_PHRASES.filter((p) => p.includes(" "))
    .map((p) => `"${p}"`)
    .join(", ");
  return `Writing rules for every text you write (code rejects violations):
- Never use these words: ${words}.
- Never use these phrases: ${phrases}.
- No em dashes or en dashes, and no spaced hyphen used as a dash. Use commas, periods, colons or parentheses.
- No "not X but Y" constructions: no "not only... but also", "it's not about X, it's about Y", "isn't just X", "less X, more Y", "no X, no Y, just Z", or any sentence that rejects one framing to assert another. State the point directly.
- No transitions like "Furthermore", "Moreover", "Additionally", "That said". No meta commentary, no hype, no closing summary.
- Use plain verbs (used, built, led, ran, wrote, fixed) and name the specific tool or result. Numbers as digits.
- Vary sentence length and openings. Avoid lists of exactly three for rhythm.`;
}

/** Your own words from the profile: banned phrases you wrote yourself are allowed. */
export function profileOwnWords(profile: Profile): string {
  return [
    ...[...indexFacts(profile).values()].map((f) => f.text),
    ...profile.experience.flatMap((e) => [e.title, e.org, `${e.title}, ${e.org}`]),
    ...profile.projects.map((x) => x.name),
  ].join("\n");
}
