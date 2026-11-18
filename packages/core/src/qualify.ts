import { degreeExcludes, gradYearsMentioned, normalizeDegree } from "./classify.ts";
import type { DegreeLevel } from "./classify.ts";
import type { Profile } from "./profile.ts";
import { primaryEducation } from "./profile.ts";
import type { RequirementMatch } from "./scoring.ts";
import type { Posting } from "./types.ts";

/**
 * "Do I meet the minimums?" for one posting. Fit scoring ranks postings; this answers a
 * different question: does the posting state hard requirements, and does the profile meet each
 * one. Only requirements the posting actually states are checked, and only ones that can be
 * judged from the profile. Work authorization and sponsorship are never judged here.
 */

export type CheckKind = "degree" | "graduation" | "gpa" | "experience" | "skill";

export interface QualifyCheck {
  kind: CheckKind;
  /** What the posting asks for, in words. */
  need: string;
  /** What the profile has, or null when it can't be told. */
  have: string | null;
  /** null: the profile can't say (e.g. no GPA recorded). Not counted for or against. */
  met: boolean | null;
}

/**
 * meets: every judged requirement is met, and at least two were found.
 * close: exactly one is not met. short: two or more are not met.
 * unknown: too little stated (or too little in the profile) to say.
 */
export type QualifyVerdict = "meets" | "close" | "short" | "unknown";

export interface Qualification {
  verdict: QualifyVerdict;
  checks: QualifyCheck[];
  /** Things the posting says that are for you to judge, never decided here. */
  notes: string[];
}

// ---- reading the posting ----

// A heading is the whole line ("Minimum Qualifications:"), never a sentence that starts with one.
const PREFERRED_HEADING =
  /^\W*((preferred|desired|bonus|ideal)\s+(qualifications|requirements|skills|experience)|preferred|nice[- ]to[- ]haves?|bonus( points)?|pluses|extra credit|desired)\W*$/i;
const REQUIRED_HEADING =
  /^\W*(((minimum|basic|required|key|core)\s+)?(qualifications|requirements|skills)(\s+(and|&)\s+(experience|skills|qualifications))?|minimum|basic|required|what you['’]?ll need|what we['’]?re looking for|who you are|must[- ]haves?|you have|you bring)\W*$/i;
const INLINE_PREFERRED =
  /\b(preferred|a plus|nice to have|bonus|ideally|desirable|not required)\b/i;
/** A line that states something as a requirement, wherever it sits in the posting. */
const REQUIREMENT_CUE =
  /\b(required|requirement|minimum|must|at least|need|you have|you['’]ve|you are|you['’]re|candidates? (with|who|have)|pursuing|enrolled|currently)\b|\d\s*\+/i;

/**
 * The lines of a description that state requirements: everything under a "minimum / required"
 * heading, plus any line phrased as a requirement. Lines under "preferred / nice to have"
 * headings, or marked "a plus", are left out.
 */
export function requirementLines(text: string): string[] {
  const out: string[] = [];
  let mode: "none" | "required" | "preferred" = "none";
  for (const raw of text.split(/\n+/)) {
    const line = raw.trim();
    if (!line) continue;
    const heading = line.length <= 60 && !/[.!?]$/.test(line);
    if (heading && PREFERRED_HEADING.test(line)) {
      mode = "preferred";
      continue;
    }
    if (heading && REQUIRED_HEADING.test(line)) {
      mode = "required";
      continue;
    }
    if (mode === "preferred" || INLINE_PREFERRED.test(line)) continue;
    if (mode === "required" || REQUIREMENT_CUE.test(line)) out.push(line);
  }
  return out;
}

const GPA_CUE = /minimum|\bmin\b|at least|or (higher|above|better)|\d\+|required|must|maintain/i;

/** A minimum GPA the posting states ("minimum GPA of 3.0", "3.5+ GPA"), or null. */
export function minimumGpa(lines: string[]): number | null {
  for (const line of lines) {
    if (!/\bgpa\b/i.test(line) || !GPA_CUE.test(line)) continue;
    for (const m of line.matchAll(/(?<![\d.])([2-4](?:\.\d{1,2})?)(?![\d])/g)) {
      const n = Number(m[1]);
      if (n >= 2 && n <= 4) return n;
    }
  }
  return null;
}

/** Months of experience the posting asks for ("2+ years of experience", "6 months of ..."), or null. */
export function minimumExperienceMonths(lines: string[]): number | null {
  let best: number | null = null;
  for (const line of lines) {
    for (const m of line.matchAll(
      /(\d+(?:\.\d+)?)\s*\+?\s*(years?|yrs?|months?)\b[^.;]{0,60}?\bexperience/gi,
    )) {
      const months = Number(m[1]) * (/^m/i.test(m[2]!) ? 1 : 12);
      if (months > 0 && (best === null || months > best)) best = months;
    }
  }
  return best;
}

const DEGREE_WORDS = /\b(associate|bachelor|master|ph\.?\s?d|doctora\w*)/gi;
const PURSUING =
  /\b(pursuing|enrolled|working toward|working towards|candidate for|student|studying)\b/i;

function levelFromWord(w: string): DegreeLevel | null {
  const s = w.toLowerCase().replace(/[.\s]/g, "");
  if (s.startsWith("associate")) return "associates";
  if (s.startsWith("bachelor")) return "bachelors";
  if (s.startsWith("master")) return "masters";
  if (s === "phd" || s.startsWith("doctora")) return "phd";
  return null;
}

/** Degree levels the posting accepts: its structured list, plus "pursuing a Master's" lines. */
export function acceptedDegrees(posting: Posting, lines: string[]): string[] {
  const out = [...posting.degrees];
  for (const line of lines) {
    if (!PURSUING.test(line)) continue;
    for (const m of line.matchAll(DEGREE_WORDS)) {
      const level = levelFromWord(m[1]!);
      if (level) out.push(level === "associates" ? "Associate" : level.replace(/s$/, ""));
    }
  }
  return out;
}

// ---- reading the profile ----

export function profileGpa(profile: Profile): number | null {
  const raw = primaryEducation(profile).gpa;
  if (raw === null || raw === undefined) return null;
  const n = parseFloat(String(raw));
  return Number.isFinite(n) ? n : null;
}

function monthIndex(ym: string): number {
  const [y, m] = ym.split("-").map(Number);
  return y! * 12 + (m! - 1);
}

/** Months across all jobs, overlapping stretches counted once. Projects and coursework don't count. */
export function experienceMonths(profile: Profile, now: Date): number {
  const nowIdx = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const spans = profile.experience
    .map((e) => [monthIndex(e.start), e.end === "present" ? nowIdx : monthIndex(e.end)] as const)
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curEnd = -Infinity;
  for (const [s, e] of spans) {
    const from = Math.max(s, curEnd);
    if (e > from) total += e - from;
    curEnd = Math.max(curEnd, e);
  }
  return total;
}

function describeMonths(m: number): string {
  if (m < 12 || m % 12 !== 0) return m === 1 ? "1 month" : `${m} months`;
  const y = m / 12;
  return y === 1 ? "1 year" : `${y} years`;
}

const LEVEL_NAME: Record<DegreeLevel, string> = {
  associates: "associate",
  bachelors: "bachelor's",
  masters: "master's",
  phd: "PhD",
};

// ---- the check ----

export function evaluateQualification(
  posting: Posting,
  profile: Profile,
  match: RequirementMatch | null,
  now: Date = new Date(),
): Qualification {
  const text = posting.descriptionText ?? "";
  const lines = requirementLines(text);
  const checks: QualifyCheck[] = [];
  const notes: string[] = [];
  const level = profile.preferences.degree_level;

  const accepted = acceptedDegrees(posting, lines);
  const levels = [
    ...new Set(accepted.map(normalizeDegree).filter((x): x is DegreeLevel => x !== null)),
  ];
  if (levels.length > 0) {
    checks.push({
      kind: "degree",
      need: `pursuing a ${levels.map((l) => LEVEL_NAME[l]).join(" or ")} degree`,
      have: `${LEVEL_NAME[level]} degree`,
      met: !degreeExcludes(accepted, level),
    });
  }

  const years = gradYearsMentioned(text);
  if (years.length > 0) {
    const grad = Number(primaryEducation(profile).grad.slice(0, 4));
    const lo = Math.min(...years);
    const hi = Math.max(...years);
    checks.push({
      kind: "graduation",
      need: lo === hi ? `graduating in ${lo}` : `graduating ${lo} to ${hi}`,
      have: `graduating ${grad}`,
      met: grad >= lo && grad <= hi,
    });
  }

  const gpaNeed = minimumGpa(lines);
  if (gpaNeed !== null) {
    const have = profileGpa(profile);
    checks.push({
      kind: "gpa",
      need: `GPA of ${gpaNeed.toFixed(1)} or higher`,
      have: have === null ? null : `GPA ${have.toFixed(2)}`,
      met: have === null ? null : have >= gpaNeed,
    });
  }

  const expNeed = minimumExperienceMonths(lines);
  if (expNeed !== null) {
    const have = experienceMonths(profile, now);
    checks.push({
      kind: "experience",
      need: `${describeMonths(expNeed)} of experience`,
      have: `${describeMonths(have)} of work experience`,
      met: have >= expNeed,
    });
  }

  if (match?.method === "model") {
    const matched = new Set(match.matched.map((m) => m.toLowerCase()));
    for (const req of match.required) {
      checks.push({
        kind: "skill",
        need: req,
        have: matched.has(req.toLowerCase()) ? "in your profile" : null,
        met: matched.has(req.toLowerCase()),
      });
    }
  }

  if (posting.sponsorship === "no_sponsorship")
    notes.push("The posting says it doesn't sponsor visas. Check that against your situation.");
  if (posting.sponsorship === "citizenship_required")
    notes.push("The posting asks for U.S. citizenship. Check that against your situation.");

  const judged = checks.filter((c) => c.met !== null);
  const unmet = judged.filter((c) => c.met === false).length;
  const verdict: QualifyVerdict =
    unmet >= 2 ? "short" : unmet === 1 ? "close" : judged.length >= 2 ? "meets" : "unknown";
  return { verdict, checks, notes };
}
