import { detectSponsorship, detectTerms, isInternshipTitle } from "@ia/core";
import type { RawPosting } from "@ia/core";
import type { GetJsonOptions } from "./http.ts";
import { getJson } from "./http.ts";

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl?: string;
  createdAt?: number;
  categories?: { location?: string; allLocations?: string[]; commitment?: string; team?: string };
  descriptionPlain?: string;
  lists?: { text: string; content: string }[];
  additionalPlain?: string;
  workplaceType?: string;
}

export function leverText(p: LeverPosting): string {
  const lists = (p.lists ?? [])
    .map((l) => `${l.text}\n${l.content.replace(/<li>/g, "- ").replace(/<[^>]+>/g, "\n")}`)
    .join("\n");
  return [p.descriptionPlain, lists, p.additionalPlain]
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n");
}

export function mapLeverPosting(p: LeverPosting, site: string, company: string): RawPosting {
  const description = leverText(p);
  const locations = p.categories?.allLocations?.length
    ? p.categories.allLocations
    : p.categories?.location
      ? [p.categories.location]
      : [];
  if (p.workplaceType === "remote" && !locations.some((l) => /remote/i.test(l)))
    locations.push("Remote");
  return {
    company,
    title: p.text,
    locations,
    ats: "lever",
    boardToken: site,
    atsJobId: p.id,
    applyUrl: p.applyUrl ?? `${p.hostedUrl}/apply`,
    sourceLinks: [p.hostedUrl],
    sources: ["lever"],
    descriptionText: description || null,
    terms: detectTerms(`${p.text}\n${description}`),
    category: p.categories?.team ?? null,
    degrees: [],
    sponsorship: detectSponsorship(null, description),
    deadline: null,
    postedAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
    isOpen: true,
  };
}

export function leverApiBase(eu = false): string {
  return eu ? "https://api.eu.lever.co/v0/postings" : "https://api.lever.co/v0/postings";
}

export async function fetchLeverSite(
  site: string,
  company: string,
  opts: GetJsonOptions,
  eu = false,
): Promise<RawPosting[]> {
  const data = await getJson<LeverPosting[]>(
    `${leverApiBase(eu)}/${encodeURIComponent(site)}?mode=json`,
    opts,
  );
  return data
    .filter((p) => isInternshipTitle(p.text))
    .map((p) => mapLeverPosting(p, site, company));
}

export async function fetchLeverPosting(
  site: string,
  id: string,
  opts: GetJsonOptions,
  eu = false,
): Promise<{ descriptionText: string | null }> {
  const p = await getJson<LeverPosting>(
    `${leverApiBase(eu)}/${encodeURIComponent(site)}/${encodeURIComponent(id)}?mode=json`,
    opts,
  );
  return { descriptionText: leverText(p) || null };
}
