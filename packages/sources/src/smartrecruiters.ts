// SmartRecruiters public Posting API: no key needed to read a company's published postings.
import { detectSponsorship, detectTerms, htmlToText, isInternshipTitle } from "@ia/core";
import type { RawPosting } from "@ia/core";
import type { GetJsonOptions } from "./http.ts";
import { getJson } from "./http.ts";

const API = "https://api.smartrecruiters.com/v1/companies";

interface SrPosting {
  id: string;
  name: string;
  releasedDate?: string;
  location?: {
    city?: string;
    region?: string;
    country?: string;
    remote?: boolean;
    fullLocation?: string;
  };
  department?: { label?: string };
  typeOfEmployment?: { label?: string };
  experienceLevel?: { id?: string; label?: string };
}

interface SrList {
  totalFound?: number;
  offset?: number;
  limit?: number;
  content?: SrPosting[];
}

export function smartRecruitersJobUrl(company: string, id: string): string {
  return `https://jobs.smartrecruiters.com/${encodeURIComponent(company)}/${encodeURIComponent(id)}`;
}

function srLocation(l: SrPosting["location"]): string[] {
  if (!l) return [];
  const place =
    l.fullLocation ?? [l.city, l.region, l.country?.toUpperCase()].filter(Boolean).join(", ");
  const out = place ? [place] : [];
  if (l.remote && !out.some((x) => /remote/i.test(x))) out.push("Remote");
  return out;
}

function isInternship(p: SrPosting): boolean {
  return (
    isInternshipTitle(p.name) ||
    /intern/i.test(p.typeOfEmployment?.label ?? "") ||
    p.experienceLevel?.id === "internship"
  );
}

export function mapSmartRecruitersPosting(
  p: SrPosting,
  company: string,
  companyName: string,
): RawPosting {
  const url = smartRecruitersJobUrl(company, p.id);
  return {
    company: companyName,
    title: p.name,
    locations: srLocation(p.location),
    ats: "smartrecruiters",
    boardToken: company,
    atsJobId: p.id,
    applyUrl: url,
    sourceLinks: [url],
    sources: ["smartrecruiters"],
    descriptionText: null,
    terms: detectTerms(p.name),
    category: p.department?.label ?? null,
    degrees: [],
    sponsorship: "unknown",
    deadline: null,
    postedAt: p.releasedDate ?? null,
    isOpen: true,
  };
}

export const SMARTRECRUITERS_PAGE_SIZE = 100;
export const SMARTRECRUITERS_MAX_PAGES = 20;

/** Internship postings for one company identifier (the slug in jobs.smartrecruiters.com/<slug>). */
export async function fetchSmartRecruitersBoard(
  company: string,
  companyName: string,
  opts: GetJsonOptions,
): Promise<RawPosting[]> {
  const out: RawPosting[] = [];
  for (let page = 0; page < SMARTRECRUITERS_MAX_PAGES; page++) {
    const offset = page * SMARTRECRUITERS_PAGE_SIZE;
    const data = await getJson<SrList>(
      `${API}/${encodeURIComponent(company)}/postings?limit=${SMARTRECRUITERS_PAGE_SIZE}&offset=${offset}`,
      opts,
    );
    const rows = data.content ?? [];
    for (const p of rows)
      if (isInternship(p)) out.push(mapSmartRecruitersPosting(p, company, companyName));
    if (rows.length < SMARTRECRUITERS_PAGE_SIZE || offset + rows.length >= (data.totalFound ?? 0))
      break;
  }
  return out;
}

interface SrDetail {
  id?: string;
  active?: boolean;
  jobAd?: { sections?: Record<string, { title?: string; text?: string } | undefined> };
}

export function smartRecruitersDetailUrl(company: string, id: string): string {
  return `${API}/${encodeURIComponent(company)}/postings/${encodeURIComponent(id)}`;
}

export async function fetchSmartRecruitersDetail(
  company: string,
  id: string,
  opts: GetJsonOptions,
): Promise<{ descriptionText: string | null; active: boolean | null }> {
  const d = await getJson<SrDetail>(smartRecruitersDetailUrl(company, id), opts);
  const sections = d.jobAd?.sections ?? {};
  const text = ["companyDescription", "jobDescription", "qualifications", "additionalInformation"]
    .map((k) => sections[k])
    .filter((s): s is { title?: string; text?: string } => Boolean(s?.text))
    .map((s) => `${s.title ?? ""}\n${htmlToText(s.text ?? "")}`.trim())
    .join("\n\n");
  return { descriptionText: text || null, active: d.active ?? null };
}

export function smartRecruitersEnrichment(description: string | null) {
  return { sponsorship: detectSponsorship(null, description) };
}
