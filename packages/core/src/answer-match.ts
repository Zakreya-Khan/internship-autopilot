import { classifyQuestion, questionKey } from "./questions.ts";
import type { KnownField } from "./questions.ts";
import type { FormQuestion } from "./types.ts";

/**
 * Matching a question on a new form to one you've answered before.
 *
 * Layers, cheapest first:
 *   (a) the exact key (the question's wording as a slug) or an alias you confirmed;
 *   (b) local similarity: normalized words, boilerplate removed, synonyms mapped, compared as sets;
 *   (c) for borderline scores only, a model is asked whether the two questions ask the same
 *       thing (done by the caller; only the two question texts are ever sent).
 * Only (a) and a very high (b) score fill a field by themselves. Anything else is a suggestion
 * you confirm.
 */

/** At or above this, a local match fills the field without asking. */
export const AUTO_MATCH = 0.9;
/** Between this and AUTO_MATCH, a match is borderline: a suggestion, checked by the model first. */
export const SUGGEST_MATCH = 0.5;

/** Answers about these never go in the learned bank: they live in profile.yaml. */
const SENSITIVE_FIELDS = new Set<KnownField>([
  "first_name",
  "last_name",
  "full_name",
  "preferred_name",
  "email",
  "phone",
  "gpa",
  "authorized_us",
  "needs_sponsorship",
  "us_citizen",
  "eeo_gender",
  "eeo_race",
  "eeo_hispanic",
  "eeo_veteran",
  "eeo_disability",
]);

const SENSITIVE_TEXT =
  /\b(gpa|grade point|e-?mail|phone|address|zip( code)?|postal code|date of birth|birth ?date|social security|ssn|sponsor|visa|work authori[sz]ation|authori[sz]ed to work|citizen|immigration|export control|u\.?s\.? person|green card|gender|race|ethnicity|hispanic|latin[oa]|veteran|disabilit|sexual orientation|pronouns?)\b/i;

/**
 * True for EEO, work authorization, GPA and contact-detail questions. You can answer them for
 * one application, but they're never saved to the learned bank or reused from it.
 */
export function isSensitiveQuestion(q: Pick<FormQuestion, "key" | "label" | "type">): boolean {
  const c = classifyQuestion(q);
  if (c.kind === "known" && SENSITIVE_FIELDS.has(c.field)) return true;
  return SENSITIVE_TEXT.test(q.label);
}

const WHY_THIS_COMPANY =
  /\bwhy (do you want to |would you like to |are you interested in )?(work|join|intern)(ing)? (at|for|with)\b|\bwhy (us|our (company|team|firm))\b|\binterest(ed)? in (joining |working (at|for) )?(this|our) (company|firm|team)\b/i;
const ABOUT_THIS_EMPLOYER =
  /\bever (been )?(employed|worked)\b|\bpreviously (worked|employed|applied)\b|former employee|worked (here|for us) before|(relatives?|family members?|spouses?|partners?|in-laws?)\b.{0,60}\b(work|employ)|non-?compete|restrictive covenant|conflicts? of interest/i;

function companyWords(company: string): string[] {
  return normalizeWords(company).filter((w) => !GENERIC_COMPANY_WORDS.has(w) && w.length > 2);
}

/** Industry words a company often drops from its own name: "Five Rings Capital" is "Five Rings". */
const TRAILING_INDUSTRY = new Set([
  "capital",
  "financial",
  "securities",
  "partners",
  "space",
  "systems",
  "technology",
  "tech",
  "health",
  "robotics",
  "ai",
  "software",
  "trading",
  "investments",
  "management",
  "holdings",
  "global",
]);

/**
 * The ways a question might name the company: its full name, and its name without trailing
 * industry words (only when what's left is distinctive: two words, or one of 4+ letters).
 */
function companyNames(company: string): string[][] {
  const full = companyWords(company);
  if (!full.length) return [];
  const core = [...full];
  while (core.length > 1 && TRAILING_INDUSTRY.has(core.at(-1)!)) core.pop();
  const distinctive = core.length >= 2 || (core.length === 1 && core[0]!.length >= 4);
  return core.length < full.length && distinctive ? [full, core] : [full];
}
const GENERIC_COMPANY_WORDS = new Set([
  "inc",
  "llc",
  "ltd",
  "corp",
  "corporation",
  "company",
  "group",
  "the",
  "and",
  "co",
  "technologies",
  "labs",
]);

/**
 * Questions about you and this employer ("Why X?", "Have you worked at X?", relatives or
 * non-competes at X). Their answers are only ever reused at the same company.
 */
export function isCompanySpecific(label: string, company: string): boolean {
  if (WHY_THIS_COMPANY.test(label) || ABOUT_THIS_EMPLOYER.test(label)) return true;
  const text = ` ${normalizeWords(label).join(" ")} `;
  return companyNames(company).some((name) => text.includes(` ${name.join(" ")} `));
}

/** Lower-case words, with punctuation, "(required)" and asterisks removed. */
function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\*|\(required\)|\(optional\)/g, " ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9+#]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

/** Words that carry no meaning in a form question. */
const BOILERPLATE = new Set(
  (
    "a an the and or of to in on at for with by from as is are be been being am was were will would " +
    "can could should shall may might do does did you your yours we our us this that these those it its " +
    "please kindly indicate confirm select choose provide let know tell share describe answer state " +
    "whether if any currently current there here which what when where how who whom required optional " +
    "question following below above apply applying applicant candidate position role job opportunity " +
    "internship intern program company firm team organization employer"
  ).split(" "),
);

/** Different words for one idea, mapped to one token. */
const SYNONYMS: [RegExp, string][] = [
  [/^(relocat\w*|move|moving|movable)$/, "relocate"],
  [/^(willing|willingness|open|able|ability|comfortable|prepared|ok|okay)$/, "willing"],
  [/^(onsite|site|inperson|office|offices)$/, "onsite"],
  [/^(hybrid)$/, "hybrid"],
  [/^(remote|remotely|wfh)$/, "remote"],
  [/^(commute|commuting|commutable|local|locally|nearby)$/, "commute"],
  [/^(start|starting|begin|beginning|available|availability|earliest)$/, "start"],
  [/^(date|dates|when|time|timing)$/, "date"],
  [/^(duration|length|long|weeks|months|period)$/, "duration"],
  [/^(summer|fall|spring|winter|semester|term|season)$/, "term"],
  [/^(full|fulltime|full-time)$/, "fulltime"],
  [/^(hours|hour|hrs|weekly|week|per)$/, "hours"],
  [/^(sponsor\w*|visa|h1b|h-1b|opt|cpt)$/, "sponsor"],
  [
    /^(authorized|authorised|authorization|authorisation|eligible|eligibility|legally)$/,
    "authorized",
  ],
  [/^(employed|worked|work|working|employment|employee|employ)$/, "work"],
  [/^(previously|before|ever|past|prior|former|formerly)$/, "previously"],
  [/^(relatives?|family|spouses?|partners?|in-laws?|related)$/, "relative"],
  [/^(heard|hear|find|found|learn|learned|discover|discovered|source|referred)$/, "hear"],
  [/^(salary|compensation|pay|wage|wages|rate)$/, "salary"],
  [/^(expectation|expectations|expected|desired)$/, "expect"],
  [/^(clearance|clearances|cleared)$/, "clearance"],
  [/^(languages?|programming)$/, "language"],
  [/^(experience|experienced|years)$/, "experience"],
  [/^(project|projects)$/, "project"],
  [/^(why|reason|reasons|motivation|motivates|interested|interest|excited|excites)$/, "why"],
  [/^(graduate|graduation|graduating)$/, "graduate"],
  [/^(citizen|citizenship|national|nationality)$/, "citizen"],
  [/^(yes|no|y|n)$/, ""],
];

function canonical(word: string): string {
  for (const [re, to] of SYNONYMS) if (re.test(word)) return to;
  // Light stemming: plurals and -ing/-ed, so "relocating" and "relocated" meet.
  return word.replace(/(ing|ed|es|s)$/, "") || word;
}

/** The meaningful, synonym-mapped words of a question. The company's own name becomes "<co>". */
export function questionTokens(label: string, company = ""): Set<string> {
  const names = companyNames(company); // longest first
  const words = normalizeWords(label);
  const out = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    const name = names.find((n) => words.slice(i, i + n.length).join(" ") === n.join(" "));
    if (name) {
      out.add("<co>");
      i += name.length - 1;
      continue;
    }
    const w = words[i]!;
    if (BOILERPLATE.has(w)) continue;
    const c = canonical(w);
    if (c) out.add(c);
  }
  return out;
}

/** 0 to 1: how alike two questions are, by their meaningful words (Dice coefficient). */
export function questionSimilarity(a: string, b: string, companyA = "", companyB = ""): number {
  const x = questionTokens(a, companyA);
  const y = questionTokens(b, companyB);
  if (x.size === 0 || y.size === 0) return 0;
  // A question about one of these topics never matches one that isn't, however alike the rest.
  for (const t of TOPICS) if (x.has(t) !== y.has(t)) return 0;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared++;
  return (2 * shared) / (x.size + y.size);
}

/** Topics that make two questions different on their own ("ever employed here" vs "relatives employed here"). */
const TOPICS = ["relative", "salary", "clearance", "relocate", "offer", "sponsor"];

export type AnswerScope = "always" | "company" | "once";

export interface LearnedAnswer {
  id: number;
  questionKey: string;
  question: string;
  answer: string;
  scope: Exclude<AnswerScope, "once">;
  /** The company a company-only answer belongs to ("" for answers reused everywhere). */
  company: string;
  /** Other wordings you confirmed mean the same question. */
  aliases: { key: string; text: string }[];
}

export interface AnswerCandidate {
  answer: LearnedAnswer;
  /** "exact" (same wording or a confirmed alias) or "similar" (local similarity). */
  how: "exact" | "similar";
  score: number;
}

/** Same company, for company-only answers: names compared by their meaningful words. */
export function sameCompany(a: string, b: string): boolean {
  const x = companyWords(a).join(" ");
  return x !== "" && x === companyWords(b).join(" ");
}

/**
 * The best learned answer for a question on a form at `company`, or null.
 * Sensitive questions never match. A company-specific question only matches answers given at
 * the same company, whatever their scope; a company-only answer only matches at its company.
 * `rejected` holds answer ids you said don't fit this question.
 */
export function findLearnedAnswer(
  q: Pick<FormQuestion, "key" | "label" | "type">,
  company: string,
  bank: LearnedAnswer[],
  rejected: Set<number> = new Set(),
): AnswerCandidate | null {
  if (isSensitiveQuestion(q)) return null;
  const key = questionKey(q.label);
  const specific = isCompanySpecific(q.label, company);
  const eligible = bank.filter((a) => {
    if (rejected.has(a.id)) return false;
    if (a.scope === "company" || specific) return sameCompany(a.company, company);
    return true;
  });
  // (a) exact wording, or a wording you confirmed.
  const exact =
    eligible.find((a) => a.questionKey === key && a.scope === "company") ??
    eligible.find((a) => a.questionKey === key || a.aliases.some((al) => al.key === key));
  if (exact) return { answer: exact, how: "exact", score: 1 };
  // (b) local similarity, against the question and every confirmed wording of it.
  let best: AnswerCandidate | null = null;
  for (const a of eligible) {
    const score = Math.max(
      questionSimilarity(q.label, a.question, company, a.company),
      ...a.aliases.map((al) => questionSimilarity(q.label, al.text, company, a.company)),
    );
    if (score >= SUGGEST_MATCH && (!best || score > best.score))
      best = { answer: a, how: "similar", score };
  }
  return best;
}

/** The default scope offered for a question: company-only for questions about this employer. */
export function defaultScope(label: string, company: string): Exclude<AnswerScope, "once"> {
  return isCompanySpecific(label, company) ? "company" : "always";
}
