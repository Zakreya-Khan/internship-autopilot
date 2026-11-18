import { degreeExcludes, detectTerms, gradYearsMentioned, isCoopTitle } from "./classify.ts";
import type { Profile } from "./profile.ts";
import { primaryEducation } from "./profile.ts";
import type { Posting } from "./types.ts";

export interface FilterResult {
  pass: boolean;
  /** Why it was dropped, in plain words. Empty when it passes. */
  reasons: string[];
}

/** "Remote", "Remote - US", "Remote in USA" count; "Remote in India" does not. */
export function isUsRemote(location: string): boolean {
  if (!/\bremote\b/i.test(location)) return false;
  const where = /\bremote\b\s*(?:in|[-–,(:])\s*([^)]+)/i.exec(location)?.[1]?.trim();
  if (!where) return true;
  return /\b(us|u\.s\.|usa|united states|america|north america|anywhere)\b/i.test(where);
}

export function matchesLocation(posting: Posting, profile: Profile): boolean {
  const prefs = profile.preferences;
  if (prefs.locations.length === 0) return true;
  if (posting.locations.length === 0) return true; // unknown: keep, the score handles it
  return posting.locations.some((loc) => {
    const l = loc.toLowerCase();
    if (prefs.allow_remote && isUsRemote(loc)) return true;
    return prefs.locations.some((want) => l.includes(want.toLowerCase()));
  });
}

/** Hard filters: anything failing one is dropped, never shown as a candidate. */
export function applyHardFilters(posting: Posting, profile: Profile): FilterResult {
  const reasons: string[] = [];
  const prefs = profile.preferences;
  const auth = profile.work_authorization;

  if (!posting.isOpen) reasons.push("closed");

  const terms = posting.terms.length
    ? posting.terms
    : detectTerms(`${posting.title} ${posting.descriptionText ?? ""}`);
  const knownTerms = terms.filter((t) => t !== "N/A");
  if (knownTerms.length > 0 && !knownTerms.some((t) => prefs.terms.includes(t))) {
    reasons.push(`term ${knownTerms.join("/")} not in ${prefs.terms.join("/")}`);
  }
  if (!prefs.include_coops && isCoopTitle(posting.title)) reasons.push("co-op");

  if (!prefs.role_families.includes(posting.roleFamily)) {
    reasons.push(`role family ${posting.roleFamily} not selected`);
  }
  if (prefs.strict_locations && !matchesLocation(posting, profile))
    reasons.push("location not in your list");

  const needsSponsorship = auth.needs_sponsorship_now || auth.needs_sponsorship_later;
  if (posting.sponsorship === "citizenship_required" && !auth.us_citizen) {
    reasons.push("U.S. citizenship required");
  }
  if (posting.sponsorship === "no_sponsorship" && needsSponsorship) {
    reasons.push("no visa sponsorship");
  }
  if (degreeExcludes(posting.degrees, prefs.degree_level)) {
    reasons.push(`degree ${posting.degrees.join("/")} excludes ${prefs.degree_level}`);
  }
  const years = gradYearsMentioned(posting.descriptionText ?? "");
  const gradYear = Number(primaryEducation(profile).grad.slice(0, 4));
  if (years.length > 0 && (gradYear < Math.min(...years) || gradYear > Math.max(...years))) {
    reasons.push(`graduation window ${years.join("-")} excludes ${gradYear}`);
  }
  return { pass: reasons.length === 0, reasons };
}
