import type { Ats } from "./types.ts";

export interface AtsRef {
  ats: Ats;
  boardToken: string | null;
  jobId: string | null;
}

const TRACKING_PARAMS = new Set([
  "gh_src",
  "source",
  "src",
  "ref",
  "referrer",
  "lever-source",
  "lever-origin",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
]);

/** Lower-case host, no tracking params, no hash, no trailing slash. Keeps `gh_jid`. */
export function canonicalizeUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return input.trim();
  }
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase()) || key.toLowerCase().startsWith("utm_")) {
      u.searchParams.delete(key);
    }
  }
  u.searchParams.sort();
  if (u.pathname.length > 1 && u.pathname.endsWith("/"))
    u.pathname = u.pathname.replace(/\/+$/, "");
  return u.toString();
}

/** Identify the ATS behind an apply URL, and its board token and job id when the URL shows them. */
export function parseAtsUrl(input: string): AtsRef {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { ats: "other", boardToken: null, jobId: null };
  }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);

  if (/(^|\.)greenhouse\.io$/.test(host)) {
    if (parts[0] === "embed") {
      return {
        ats: "greenhouse",
        boardToken: u.searchParams.get("for"),
        jobId: u.searchParams.get("token"),
      };
    }
    const jobsAt = parts.indexOf("jobs");
    return {
      ats: "greenhouse",
      boardToken: parts[0] ?? null,
      jobId: jobsAt >= 0 ? (parts[jobsAt + 1] ?? null) : null,
    };
  }
  const ghJid = u.searchParams.get("gh_jid");
  if (ghJid) return { ats: "greenhouse", boardToken: null, jobId: ghJid };

  if (/(^|\.)lever\.co$/.test(host) && host.startsWith("jobs.")) {
    return { ats: "lever", boardToken: parts[0] ?? null, jobId: parts[1] ?? null };
  }
  if (host === "jobs.ashbyhq.com") {
    return { ats: "ashby", boardToken: parts[0] ?? null, jobId: parts[1] ?? null };
  }
  if (host.endsWith(".myworkdayjobs.com") || host.endsWith(".myworkdaysite.com")) {
    const tenant = host.split(".")[0] ?? null;
    const last = parts.at(-1) ?? "";
    const m = /_([A-Za-z]*-?\d[\w-]*)$/.exec(last);
    return { ats: "workday", boardToken: tenant, jobId: m?.[1] ?? (last || null) };
  }
  if (host === "jobs.smartrecruiters.com" || host === "careers.smartrecruiters.com") {
    const m = /^(\d+)/.exec(parts[1] ?? "");
    return { ats: "smartrecruiters", boardToken: parts[0] ?? null, jobId: m?.[1] ?? null };
  }
  if (host.endsWith(".icims.com")) {
    const company = /^(?:careers-|jobs-)?([^.]+)\.icims\.com$/.exec(host)?.[1] ?? null;
    const jobsAt = parts.indexOf("jobs");
    return {
      ats: "icims",
      boardToken: company,
      jobId: jobsAt >= 0 ? (parts[jobsAt + 1] ?? null) : null,
    };
  }
  return { ats: "other", boardToken: null, jobId: null };
}

export function postingId(ref: AtsRef, applyUrl: string): string {
  if (ref.ats !== "other" && ref.jobId) {
    return `${ref.ats}:${(ref.boardToken ?? "").toLowerCase()}:${ref.jobId}`;
  }
  return `url:${canonicalizeUrl(applyUrl)}`;
}
