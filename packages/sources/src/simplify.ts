import { detectSponsorship, parseAtsUrl } from "@ia/core";
import type { RawPosting } from "@ia/core";
import { z } from "zod";
import type { GetJsonOptions } from "./http.ts";
import { getJson } from "./http.ts";

export const SIMPLIFY_REPO = "https://github.com/SimplifyJobs/Summer2027-Internships";
export const SIMPLIFY_LISTINGS_URL =
  "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json";

const Listing = z.object({
  id: z.string(),
  company_name: z.string(),
  title: z.string(),
  url: z.string(),
  locations: z.array(z.string()).default([]),
  terms: z.array(z.string()).default([]),
  active: z.boolean().default(true),
  is_visible: z.boolean().default(true),
  sponsorship: z.string().nullable().default(null),
  degrees: z.array(z.string()).default([]),
  category: z.string().nullable().default(null),
  date_posted: z.number().nullable().default(null),
});
export type SimplifyListing = z.infer<typeof Listing>;

export function mapSimplifyListing(l: SimplifyListing): RawPosting {
  const ref = parseAtsUrl(l.url);
  return {
    company: l.company_name,
    title: l.title,
    locations: l.locations,
    ats: ref.ats,
    boardToken: ref.boardToken,
    atsJobId: ref.jobId,
    applyUrl: l.url,
    sourceLinks: [SIMPLIFY_REPO],
    sources: ["simplify"],
    descriptionText: null,
    terms: l.terms,
    category: l.category,
    degrees: l.degrees,
    sponsorship: detectSponsorship(l.sponsorship, null),
    deadline: null,
    postedAt: l.date_posted ? new Date(l.date_posted * 1000).toISOString() : null,
    isOpen: l.active,
  };
}

/**
 * The community list's data file. Hidden rows are dropped; inactive rows are kept
 * (marked closed) so a role you already track can be closed out.
 */
export async function fetchSimplify(
  opts: GetJsonOptions,
  url = SIMPLIFY_LISTINGS_URL,
): Promise<RawPosting[]> {
  const raw = await getJson<unknown[]>(url, opts);
  const out: RawPosting[] = [];
  for (const row of raw) {
    const parsed = Listing.safeParse(row);
    if (parsed.success && parsed.data.is_visible) out.push(mapSimplifyListing(parsed.data));
  }
  return out;
}
