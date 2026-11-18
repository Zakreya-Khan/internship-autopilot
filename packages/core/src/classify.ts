import type { RoleFamily } from "./profile.ts";
import type { Sponsorship } from "./types.ts";

const CATEGORY_FAMILY: [RegExp, RoleFamily][] = [
  [/quant/i, "quant"],
  [/product/i, "pm"],
  [/hardware/i, "hardware"],
  [/\b(ai|ml)\b|data|machine learning/i, "data_ml"],
  [/software/i, "swe"],
];

const TITLE_FAMILY: [RegExp, RoleFamily][] = [
  [/\b(quant|quantitative|trading|trader)\b/i, "quant"],
  [/\b(product manag|product management|\bapm\b|program manag)/i, "pm"],
  [/\b(hardware|electrical|asic|fpga|firmware|embedded|silicon|rf|mechanical)\b/i, "hardware"],
  [
    /\b(machine learning|\bml\b|\bai\b|data scien|data engineer|data analyst|analytics|research scientist)/i,
    "data_ml",
  ],
  [
    /\b(software|swe|developer|backend|back-end|frontend|front-end|full[- ]?stack|engineer|devops|sre|mobile|ios|android|security)\b/i,
    "swe",
  ],
];

/** Classify a role. The list's category wins when present; otherwise the title decides. */
export function classifyRoleFamily(title: string, category?: string | null): RoleFamily {
  if (category) {
    for (const [re, fam] of CATEGORY_FAMILY) if (re.test(category)) return fam;
  }
  for (const [re, fam] of TITLE_FAMILY) if (re.test(title)) return fam;
  return "other";
}

export function isInternshipTitle(title: string): boolean {
  return /\b(intern|internship|co-?op|apprentice|summer analyst|summer associate)\b/i.test(title);
}

export function isCoopTitle(title: string): boolean {
  return /\bco-?op\b/i.test(title);
}

/** Terms like "Summer 2027" mentioned in a title or description. */
export function detectTerms(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(summer|fall|autumn|spring|winter)\s*('|20)?(\d{2})\b/gi)) {
    const season = m[1]!.toLowerCase() === "autumn" ? "Fall" : cap(m[1]!);
    out.add(`${season} 20${m[3]}`);
  }
  return [...out];
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

const NO_SPONSOR = [
  /(not|unable to|cannot|can['’]t|won['’]t|will not|do not|does not|don['’]t|doesn['’]t)\s+(provide|offer|sponsor|support)[^.]{0,40}(sponsorship|visa)/i,
  /without (the )?need (for|of) (current or future )?(visa )?sponsorship/i,
  /no (visa )?sponsorship/i,
  /must be (legally )?authorized to work in the (u\.?s\.?|united states) without/i,
];
const CITIZEN = [
  /(u\.?s\.?|united states) citizenship (is )?required/i,
  /must be a (u\.?s\.?|united states) citizen/i,
  /(security|government) clearance/i,
  /\bitar\b/i,
];

/** Merge a list's sponsorship flag with what the description says. The stricter one wins. */
export function detectSponsorship(
  listFlag: string | null | undefined,
  description: string | null,
): Sponsorship {
  const flag = (listFlag ?? "").toLowerCase();
  if (flag.includes("citizenship")) return "citizenship_required";
  const text = description ?? "";
  if (CITIZEN.some((re) => re.test(text))) return "citizenship_required";
  if (flag.includes("does not") || NO_SPONSOR.some((re) => re.test(text))) return "no_sponsorship";
  if (flag.includes("offers")) return "offers";
  return "unknown";
}

export type DegreeLevel = "associates" | "bachelors" | "masters" | "phd";

export function normalizeDegree(d: string): DegreeLevel | null {
  const s = d.toLowerCase();
  if (s.startsWith("associate")) return "associates";
  if (s.startsWith("bachelor")) return "bachelors";
  if (s.startsWith("master") || s === "mba") return "masters";
  if (s === "phd" || s.startsWith("doctor")) return "phd";
  return null;
}

/**
 * True when a posting's accepted degrees exclude the user's level.
 * An empty list means "not stated", which is not a reason to drop it.
 */
export function degreeExcludes(accepted: string[], userLevel: DegreeLevel): boolean {
  const levels = accepted.map(normalizeDegree).filter((x): x is DegreeLevel => x !== null);
  if (levels.length === 0) return false;
  return !levels.includes(userLevel);
}

/** "graduating between Dec 2027 and Jun 2028", "class of 2028": the graduation years a posting names. */
export function gradYearsMentioned(text: string): number[] {
  const years = new Set<number>();
  const patterns = [
    /graduat\w*[^.]{0,60}?\b(20\d\d)\b(?:[^.]{0,30}?\b(20\d\d)\b)?/gi,
    /class of (20\d\d)/gi,
    /expected (?:graduation|grad)[^.]{0,30}?\b(20\d\d)\b/gi,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      for (const g of m.slice(1)) if (g) years.add(Number(g));
    }
  }
  return [...years].sort();
}
