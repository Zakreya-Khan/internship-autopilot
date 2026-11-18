import { detectSponsorship, detectTerms, isInternshipTitle } from "@ia/core";
import type { RawPosting } from "@ia/core";
import type { GetJsonOptions } from "./http.ts";
import { getJson } from "./http.ts";

interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  secondaryLocations?: { location: string }[];
  isRemote?: boolean;
  isListed?: boolean;
  employmentType?: string;
  jobUrl: string;
  applyUrl?: string;
  descriptionPlain?: string;
  publishedAt?: string;
  department?: string;
}

export function mapAshbyJob(j: AshbyJob, org: string, company: string): RawPosting {
  const locations = [j.location, ...(j.secondaryLocations ?? []).map((s) => s.location)].filter(
    (x): x is string => Boolean(x),
  );
  if (j.isRemote && !locations.some((l) => /remote/i.test(l))) locations.push("Remote");
  const description = j.descriptionPlain ?? null;
  return {
    company,
    title: j.title,
    locations,
    ats: "ashby",
    boardToken: org,
    atsJobId: j.id,
    applyUrl: j.applyUrl ?? `${j.jobUrl}/application`,
    sourceLinks: [j.jobUrl],
    sources: ["ashby"],
    descriptionText: description,
    terms: detectTerms(`${j.title}\n${description ?? ""}`),
    category: j.department ?? null,
    degrees: [],
    sponsorship: detectSponsorship(null, description),
    deadline: null,
    postedAt: j.publishedAt ?? null,
    isOpen: true,
  };
}

export async function fetchAshbyBoard(
  org: string,
  company: string,
  opts: GetJsonOptions,
): Promise<RawPosting[]> {
  const data = await getJson<{ jobs: AshbyJob[] }>(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}?includeCompensation=true`,
    opts,
  );
  return data.jobs
    .filter((j) => j.isListed !== false)
    .filter((j) => j.employmentType === "Intern" || isInternshipTitle(j.title))
    .map((j) => mapAshbyJob(j, org, company));
}
