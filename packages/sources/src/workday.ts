// Workday careers sites, through the same public JSON endpoint the careers page itself calls.
// Approach adapted from career-ops (MIT, see NOTICE): POST .../wday/cxs/<tenant>/<site>/jobs,
// paginated, with the relative "Posted N Days Ago" label turned into a date.
import { detectSponsorship, detectTerms, htmlToText, isInternshipTitle } from "@ia/core";
import type { RawPosting } from "@ia/core";
import type { GetJsonOptions } from "./http.ts";
import { getJson, postJson } from "./http.ts";

export interface WorkdaySite {
  /** e.g. "example.wd5.myworkdayjobs.com" */
  host: string;
  tenant: string;
  site: string;
  /** The careers page as you'd open it, without a locale: https://host/site */
  origin: string;
}

const LOCALE = /^[a-z]{2}(-[A-Za-z]{2,4})?$/;

/**
 * Parse a careers-site URL: https://<tenant>.<wdN>.myworkdayjobs.com/[<locale>/]<site>[/job/...].
 * Also accepts myworkdaysite.com URLs of the form /recruiting/<tenant>/<site>.
 */
export function parseWorkdayUrl(input: string): WorkdaySite | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  if (host.endsWith(".myworkdaysite.com")) {
    const at = parts.indexOf("recruiting");
    const tenant = at >= 0 ? parts[at + 1] : undefined;
    const site = at >= 0 ? parts[at + 2] : undefined;
    if (!tenant || !site) return null;
    return { host, tenant, site, origin: `https://${host}/recruiting/${tenant}/${site}` };
  }
  if (!host.endsWith(".myworkdayjobs.com")) return null;
  const tenant = host.split(".")[0];
  if (parts[0] && LOCALE.test(parts[0])) parts.shift();
  const site = parts[0];
  if (!tenant || !site || site === "wday") return null;
  return { host, tenant, site, origin: `https://${host}/${site}` };
}

export function workdayApiBase(s: WorkdaySite): string {
  return `https://${s.host}/wday/cxs/${encodeURIComponent(s.tenant)}/${encodeURIComponent(s.site)}`;
}

/**
 * "Posted Today" → today, "Posted Yesterday" → yesterday, "Posted 5 Days Ago" → 5 days back.
 * "Posted 30+ Days Ago" and anything unrecognized → null: the exact date isn't known.
 */
export function parseWorkdayPostedOn(label: string | null | undefined, now: Date): string | null {
  if (!label) return null;
  const t = label.toLowerCase().replace(/\s+/g, " ").trim();
  if (/\+/.test(t)) return null;
  let days: number | null = null;
  if (/\btoday\b/.test(t)) days = 0;
  else if (/\byesterday\b/.test(t)) days = 1;
  else {
    const m = /\b(\d{1,2}) days? ago\b/.exec(t);
    if (m) days = Number(m[1]);
  }
  if (days === null) return null;
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

interface WdListPosting {
  title?: string;
  externalPath?: string;
  locationsText?: string;
  postedOn?: string;
  bulletFields?: string[];
}

interface WdListResponse {
  total?: number;
  jobPostings?: WdListPosting[];
}

/** The job id at the end of a Workday job path: ".../Software-Intern_JR12345" → "JR12345". */
export function workdayJobId(path: string): string | null {
  const last = path.split("/").filter(Boolean).at(-1) ?? "";
  const m = /_([A-Za-z]*-?\d[\w-]*)$/.exec(last);
  return m?.[1] ?? (last || null);
}

/**
 * "2 Locations" says nothing; the real list only comes with the detail call. Keep it empty
 * rather than storing a count as a place.
 */
function locationsFrom(text: string | undefined): string[] {
  if (!text || /^\d+\s+locations?$/i.test(text.trim())) return [];
  return [text.trim()];
}

export function mapWorkdayPosting(
  j: WdListPosting,
  site: WorkdaySite,
  company: string,
  now: Date,
): RawPosting | null {
  const title = (j.title ?? "").trim();
  if (!title || !j.externalPath) return null;
  const applyUrl = `${site.origin}${j.externalPath}`;
  const jobId = workdayJobId(j.externalPath);
  return {
    company,
    title,
    locations: locationsFrom(j.locationsText),
    ats: "workday",
    boardToken: site.tenant,
    atsJobId: jobId,
    applyUrl,
    sourceLinks: [applyUrl],
    sources: ["workday"],
    descriptionText: null,
    terms: detectTerms(title),
    category: null,
    degrees: [],
    sponsorship: "unknown",
    deadline: null,
    postedAt: parseWorkdayPostedOn(j.postedOn, now),
    isOpen: true,
  };
}

export const WORKDAY_PAGE_SIZE = 20;
/** Per search term. Results are relevance-ranked, so internships come first. */
export const WORKDAY_MAX_PAGES = 15;
/** Workday's search is fuzzy ("intern" also finds "international"), so ask twice. */
export const WORKDAY_SEARCHES = ["intern", "internship"];

/**
 * Internship postings on one Workday site. Searches server-side, pages through the ranked
 * results, and stops at the first page with no internship titles on it. Titles are then
 * filtered locally the same way as every other source.
 */
export async function fetchWorkdayBoard(
  careersUrl: string,
  company: string,
  opts: GetJsonOptions,
  now: Date = new Date(),
  searches: string[] = WORKDAY_SEARCHES,
): Promise<RawPosting[]> {
  const site = parseWorkdayUrl(careersUrl);
  if (!site) throw new Error(`Not a Workday careers URL: ${careersUrl}`);
  const url = `${workdayApiBase(site)}/jobs`;
  const out: RawPosting[] = [];
  const seen = new Set<string>();
  for (const searchText of searches) {
    let total = Infinity;
    for (let page = 0; page < WORKDAY_MAX_PAGES; page++) {
      const offset = page * WORKDAY_PAGE_SIZE;
      if (offset >= total) break;
      const data = await postJson<WdListResponse>(
        url,
        { appliedFacets: {}, limit: WORKDAY_PAGE_SIZE, offset, searchText },
        opts,
      );
      // Workday reports the total on the first page only; later pages say 0.
      if (page === 0) total = data.total ?? 0;
      const rows = data.jobPostings ?? [];
      let interns = 0;
      for (const j of rows) {
        const p = mapWorkdayPosting(j, site, company, now);
        if (!p || !isInternshipTitle(p.title)) continue;
        interns++;
        if (seen.has(p.applyUrl)) continue;
        seen.add(p.applyUrl);
        out.push(p);
      }
      if (rows.length < WORKDAY_PAGE_SIZE || (page > 0 && interns === 0)) break;
    }
  }
  return out;
}

interface WdDetail {
  jobPostingInfo?: {
    title?: string;
    jobDescription?: string;
    location?: string;
    additionalLocations?: string[];
    startDate?: string;
    endDate?: string | null;
    canApply?: boolean;
    postedOn?: string;
    jobReqId?: string;
  };
}

/** The detail endpoint for a job URL, or null if the URL isn't a Workday job page. */
export function workdayDetailUrl(applyUrl: string): string | null {
  const site = parseWorkdayUrl(applyUrl);
  if (!site) return null;
  const path = new URL(applyUrl).pathname;
  const at = path.indexOf("/job/");
  if (at < 0) return null;
  return `${workdayApiBase(site)}${path.slice(at).replace(/\/apply\/?.*$/, "")}`;
}

/** Description, locations and closing date for one Workday job. */
export async function fetchWorkdayDetail(
  applyUrl: string,
  opts: GetJsonOptions,
): Promise<{
  descriptionText: string | null;
  locations: string[];
  deadline: string | null;
  canApply: boolean | null;
} | null> {
  const url = workdayDetailUrl(applyUrl);
  if (!url) return null;
  const d = await getJson<WdDetail>(url, opts);
  const info = d.jobPostingInfo;
  if (!info) return null;
  const description = info.jobDescription ? htmlToText(info.jobDescription) : null;
  return {
    descriptionText: description,
    locations: [info.location, ...(info.additionalLocations ?? [])].filter((x): x is string =>
      Boolean(x),
    ),
    deadline: info.endDate ? info.endDate.slice(0, 10) : null,
    canApply: info.canApply ?? null,
  };
}

/** Sponsorship and terms need the description, which only the detail call has. */
export function workdayEnrichment(description: string | null) {
  return {
    sponsorship: detectSponsorship(null, description),
    terms: description ? detectTerms(description) : [],
  };
}
