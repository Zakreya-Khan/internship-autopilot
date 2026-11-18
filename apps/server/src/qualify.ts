import { evaluateQualification } from "@ia/core";
import type { Profile, Qualification, Tier } from "@ia/core";
import type { Store } from "./db.ts";

export interface QualifyRow {
  postingId: string;
  company: string;
  title: string;
  applyUrl: string;
  locations: string[];
  tier: Tier | null;
  score: number | null;
  /** The application's id once the posting has been prepared, else null. */
  applicationId: number | null;
  qualification: Qualification;
}

/**
 * Open candidates that state hard requirements, with whether you meet them: "meets" (every
 * stated minimum met) or "close" (exactly one short). Best fit first. Postings that state too
 * little to judge, and ones you're two or more short of, are left out.
 */
export function qualifyCandidates(
  store: Store,
  profile: Profile,
  opts: { verdict: "meets" | "close"; tier?: Tier; now?: Date },
): QualifyRow[] {
  const rows: QualifyRow[] = [];
  for (const { posting: p, score } of store.rankedCandidates(5000)) {
    if (opts.tier && score.fit?.tier !== opts.tier) continue;
    const qualification = evaluateQualification(p, profile, score.fit?.match ?? null, opts.now);
    if (qualification.verdict !== opts.verdict) continue;
    rows.push({
      postingId: p.id,
      company: p.company,
      title: p.title,
      applyUrl: p.applyUrl,
      locations: p.locations,
      tier: score.fit?.tier ?? null,
      score: score.fit?.score ?? null,
      applicationId: store.applicationForPosting(p.id)?.id ?? null,
      qualification,
    });
  }
  return rows;
}
