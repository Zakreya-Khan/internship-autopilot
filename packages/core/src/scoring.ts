import { gradYearsMentioned } from "./classify.ts";
import { isUsRemote } from "./filters.ts";
import type { Profile } from "./profile.ts";
import { primaryEducation } from "./profile.ts";
import { containsTerm, normalizeCompany } from "./text.ts";
import type { Posting } from "./types.ts";

export type Tier = "A" | "B" | "C";

/** What the model (or the offline fallback) found when comparing requirements with the profile. */
export interface RequirementMatch {
  required: string[];
  matched: string[];
  missing: string[];
  /** "model" = Claude read the description; "keywords" = offline fallback. */
  method: "model" | "keywords" | "no_description";
}

export interface FitComponents {
  skills: number;
  roleFamily: number;
  education: number;
  location: number;
  company: number;
  freshness: number;
}

export interface FitScore {
  score: number;
  tier: Tier;
  components: FitComponents;
  match: RequirementMatch;
}

export const WEIGHTS: FitComponents = {
  skills: 30,
  roleFamily: 25,
  education: 15,
  location: 10,
  company: 10,
  freshness: 10,
};

/** Offline requirement match: which of your skills and tools the description names. */
export function keywordRequirementMatch(posting: Posting, profile: Profile): RequirementMatch {
  const text = `${posting.title}\n${posting.descriptionText ?? ""}`;
  const mine = new Set<string>();
  for (const s of profile.skills) mine.add(s.name.toLowerCase());
  for (const x of [...profile.experience, ...profile.projects]) {
    for (const f of x.facts) for (const t of f.tools) mine.add(t.toLowerCase());
  }
  const matched = [...mine].filter((s) => containsTerm(text, s));
  if (!posting.descriptionText)
    return { required: [], matched, missing: [], method: "no_description" };
  return { required: [], matched, missing: [], method: "keywords" };
}

function skillsPoints(m: RequirementMatch): number {
  // Unknown is not a mismatch: half marks until a description is fetched.
  if (m.method === "no_description") return WEIGHTS.skills * 0.5;
  if (m.method === "model" && m.required.length > 0) {
    return WEIGHTS.skills * Math.min(1, m.matched.length / m.required.length);
  }
  // Keyword fallback has no list of requirements, so it is capped below full marks.
  return WEIGHTS.skills * 0.8 * Math.min(1, m.matched.length / 4);
}

function rankPoints(index: number, max: number): number {
  if (index < 0) return 0;
  return Math.max(max * 0.4, max - index * (max * 0.2));
}

function locationPoints(posting: Posting, profile: Profile): number {
  const prefs = profile.preferences;
  if (posting.locations.length === 0) return WEIGHTS.location * 0.5;
  if (prefs.locations.length === 0) return WEIGHTS.location;
  let best = -1;
  for (const loc of posting.locations) {
    const l = loc.toLowerCase();
    const i = prefs.locations.findIndex((w) => l.includes(w.toLowerCase()));
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  if (best >= 0) return rankPoints(best, WEIGHTS.location);
  if (prefs.allow_remote && posting.locations.some(isUsRemote)) return WEIGHTS.location * 0.8;
  return 0;
}

function educationPoints(posting: Posting, profile: Profile): number {
  const years = gradYearsMentioned(posting.descriptionText ?? "");
  if (years.length === 0) return WEIGHTS.education;
  const gradYear = Number(primaryEducation(profile).grad.slice(0, 4));
  return years.includes(gradYear) ||
    (gradYear >= Math.min(...years) && gradYear <= Math.max(...years))
    ? WEIGHTS.education
    : WEIGHTS.education / 3;
}

function freshnessPoints(firstSeen: string, now: Date): number {
  const days = (now.getTime() - Date.parse(firstSeen)) / 86_400_000;
  if (days <= 3) return 10;
  if (days <= 7) return 8;
  if (days <= 14) return 6;
  if (days <= 30) return 4;
  return 2;
}

export function isTargetCompany(company: string, profile: Profile): boolean {
  const c = normalizeCompany(company);
  return profile.preferences.target_companies.some((t) => normalizeCompany(t) === c);
}

function companyPoints(company: string, profile: Profile): number {
  if (isTargetCompany(company, profile)) return WEIGHTS.company;
  const c = normalizeCompany(company);
  if (profile.preferences.watchlist.some((w) => normalizeCompany(w.company) === c)) return 6;
  return 3;
}

export function tierFor(score: number, company: string, profile: Profile): Tier {
  const t = profile.preferences.tier_thresholds;
  if (score >= t.a || isTargetCompany(company, profile)) return "A";
  if (score >= t.b) return "B";
  return "C";
}

export function computeFitScore(
  posting: Posting,
  profile: Profile,
  match: RequirementMatch = keywordRequirementMatch(posting, profile),
  now: Date = new Date(),
): FitScore {
  const components: FitComponents = {
    skills: skillsPoints(match),
    roleFamily: rankPoints(
      profile.preferences.role_families.indexOf(posting.roleFamily),
      WEIGHTS.roleFamily,
    ),
    education: educationPoints(posting, profile),
    location: locationPoints(posting, profile),
    company: companyPoints(posting.company, profile),
    freshness: freshnessPoints(posting.postedAt ?? posting.firstSeen, now),
  };
  const score = Math.round(Object.values(components).reduce((a, b) => a + b, 0));
  return { score, tier: tierFor(score, posting.company, profile), components, match };
}
