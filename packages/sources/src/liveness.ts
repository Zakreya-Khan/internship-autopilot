// Is a posting still open? Ask the job board's public API first, then read the page.
// Rules and patterns adapted from career-ops (MIT, see NOTICE): liveness-core.mjs and
// liveness-api.mjs. A posting is called expired only on a definitive signal (HTTP 404/410 from
// an API that means it, or a recognized closed/filled banner). Everything else is "uncertain",
// and uncertain postings are kept: wrongly dropping a live job costs more than missing a dead one.
import { decodeEntities, parseAtsUrl } from "@ia/core";
import type { Posting } from "@ia/core";
import type { FetchFn, HostRateLimiter } from "./http.ts";
import { USER_AGENT } from "./http.ts";
import { workdayDetailUrl } from "./workday.ts";

export type LivenessVerdict = "active" | "expired" | "uncertain";

export interface LivenessResult {
  verdict: LivenessVerdict;
  /** Short machine code, e.g. "greenhouse_api_gone", "expired_body", "access_blocked". */
  code: string;
  reason: string;
  via: "api" | "page";
}

export interface LivenessOptions {
  fetch: FetchFn;
  limiter?: HostRateLimiter;
  timeoutMs?: number;
  /** One Ashby board read serves every job on it within a run. */
  boardCache?: Map<string, unknown>;
}

export type LivenessRef = Pick<Posting, "applyUrl" | "ats" | "boardToken" | "atsJobId">;

// ---------------------------------------------------------------- text matching

/** ASCII quotes, no accents, collapsed whitespace: every pattern below is written in this alphabet. */
export function normalizeForMatch(text: unknown, opts: { keepLineBreaks?: boolean } = {}): string {
  if (typeof text !== "string") return "";
  return text
    .replace(/[\u2018\u2019\u02BC\u2032\u00B4`]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"')
    .normalize("NFD")
    .replace(/[\u0300-\u036F]/g, "")
    .replace(/\s+/g, (run) => (opts.keepLineBreaks && run.includes("\n") ? "\n" : " "));
}

export const HARD_EXPIRED_PATTERNS: RegExp[] = [
  /job (is )?no longer available/i,
  /job.*no longer open/i,
  /\b(?:job|jobs|position|role|posting|opening|vacancy|requisition|req|listing)\b[\s\S]{0,60}?(?<!\b(?:application|form)\s)has been filled\b(?!\s+out)/i,
  /this job has expired/i,
  /job posting has expired/i,
  /no longer accepting applications/i,
  /this (position|role|job) (is )?no longer/i,
  /this (?:job|role|position)(?: listing)? is closed\b(?!-)/i,
  /job (listing )?not found/i,
  /\bsorry,? this job was removed\b/i,
  /can't view this job because it's not available/i,
  /the page you are looking for doesn.t exist/i,
  /\bthe job you(?:'re| are) (?:looking|searching) for (?:may |might |could )?(?:have |has )?closed\b/i,
  /applications?\s+(?:(?:have|are|is)\s+)?closed(?!\s*\?)/i,
  /(?<!\bbe\s)closed on \d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
  /(?<!\bbe\s)closed on (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}/i,
  // A few non-English closure banners seen on international postings.
  /diese stelle (ist )?(nicht mehr|bereits) besetzt/i,
  /offre (expiree|n'est plus disponible)/i,
  /(cette )?offre n'est plus (disponible|en ligne|active)/i,
  /ce poste n'est plus (disponible|a pourvoir|ouvert)/i,
];

/** "until the position has been filled" is a condition, not a closure. */
const TIME_OR_CONDITION_CLAUSE =
  /\b(?:until|till|once|when|whenever|after|before|unless|if|whether|as soon as) (?:[^\s.,;:!?\u2026|\u2022\u00B7]+ ){0,9}[^\s.,;:!?\u2026|\u2022\u00B7]+$/iu;

/** The first hard closure statement that isn't inside a conditional clause, or null. */
export function closureStatement(raw: string): string | null {
  const lines = normalizeForMatch(raw, { keepLineBreaks: true });
  const flat = lines.replace(/\n/g, " ");
  for (const p of HARD_EXPIRED_PATTERNS) {
    const g = new RegExp(p.source, p.flags.includes("g") ? p.flags : `${p.flags}g`);
    for (const m of flat.matchAll(g)) {
      const end = (m.index ?? 0) + m[0].length;
      if (!TIME_OR_CONDITION_CLAUSE.test(lines.slice(0, end))) return m[0];
    }
  }
  return null;
}

const SOFT_EXPIRED_PATTERNS = [/\bjob expired\b/i];
const LISTING_PAGE_PATTERNS = [/\d+\s+jobs?\s+found/i, /search for jobs page is loaded/i];
const EXPIRED_URL_PATTERNS = [/[?&]error=true/i];
const BOT_CHALLENGE_PATTERNS = [
  /just a moment/i,
  /performing security verification/i,
  /checking your browser before/i,
  /verify you are (a |not a )?human/i,
  /enable javascript and cookies to continue/i,
  /attention required.*cloudflare/i,
  /\bray id\b/i,
  /\bcf-ray\b/i,
  /please complete the security check/i,
];
const APPLY_PATTERNS = [
  /\bapply\b/i,
  /submit application/i,
  /easy apply/i,
  /start application/i,
  /\bbewerben\b/i,
  /\bpostuler\b/i,
];
export const MIN_CONTENT_CHARS = 300;

/** The last long id in a URL (a UUID or 5+ digits), used to tell if a redirect lost the job. */
export function jobIdToken(url: string): string | null {
  const all = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{5,}/gi);
  return all?.at(-1)?.toLowerCase() ?? null;
}

export interface PageEvidence {
  status: number;
  requestedUrl: string;
  finalUrl: string;
  bodyText: string;
  /** Visible button and link labels. */
  applyControls: string[];
}

/** Classify a fetched page. Order matters; see career-ops liveness-core for the rationale. */
export function classifyPage(e: PageEvidence): LivenessResult {
  const page = (verdict: LivenessVerdict, code: string, reason: string): LivenessResult => ({
    verdict,
    code,
    reason,
    via: "page",
  });
  const body = normalizeForMatch(e.bodyText);
  if (e.status === 404 || e.status === 410) return page("expired", "http_gone", `HTTP ${e.status}`);
  if (BOT_CHALLENGE_PATTERNS.some((p) => p.test(body)))
    return page("uncertain", "bot_challenge", "the site showed a bot check");
  if ([401, 403, 429, 451, 503].includes(e.status))
    return page("uncertain", "access_blocked", `HTTP ${e.status}`);
  if (e.status >= 500) return page("uncertain", "server_error", `HTTP ${e.status}`);
  if (e.status >= 300 && e.status < 400)
    return page("uncertain", "redirect", `HTTP ${e.status} with no page to read`);
  if (EXPIRED_URL_PATTERNS.some((p) => p.test(e.finalUrl)))
    return page("expired", "expired_url", `redirected to ${e.finalUrl}`);
  const closed = closureStatement(e.bodyText);
  if (closed) return page("expired", "expired_body", `the page says "${closed}"`);
  const id = jobIdToken(e.requestedUrl);
  if (id && e.finalUrl && !e.finalUrl.toLowerCase().includes(id))
    return page("uncertain", "redirected_off_posting", `redirected to ${e.finalUrl}`);
  const controls = e.applyControls.map((c) => normalizeForMatch(c));
  if (controls.some((c) => APPLY_PATTERNS.some((p) => p.test(c))))
    return page("active", "apply_control_visible", "the page shows an Apply control");
  if (SOFT_EXPIRED_PATTERNS.some((p) => p.test(body)))
    return page("expired", "expired_body_soft", "the page says the job expired");
  if (LISTING_PAGE_PATTERNS.some((p) => p.test(body)))
    return page("expired", "listing_page", "the link now shows a job search page");
  if (body.trim().length < MIN_CONTENT_CHARS)
    return page(
      "uncertain",
      "insufficient_content",
      "too little text to judge (page renders in JS)",
    );
  return page("uncertain", "no_apply_control", "no Apply control and no closure notice");
}

/** Visible text and button/link labels from raw HTML, without running scripts. */
export function pageEvidenceFromHtml(html: string): { bodyText: string; applyControls: string[] } {
  const clean = html
    .replace(/<(script|style|noscript|template)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const controls: string[] = [];
  for (const m of clean.matchAll(/<(a|button)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const label = decodeEntities(m[2]!.replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
    if (label && label.length <= 80) controls.push(label);
  }
  for (const m of clean.matchAll(/<input\b[^>]*type=["']?(?:submit|button)[^>]*>/gi)) {
    const v = /value=["']([^"']+)["']/i.exec(m[0]);
    if (v?.[1]) controls.push(decodeEntities(v[1]));
  }
  const bodyText = decodeEntities(
    clean
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|section|article|tr|header|footer|main)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  return { bodyText, applyControls: controls };
}

// ---------------------------------------------------------------- network

interface RawResponse {
  status: number;
  url: string;
  location: string | null;
  text: () => Promise<string>;
}

async function rawGet(
  url: string,
  opts: LivenessOptions,
  init: { redirect?: RequestRedirect; accept?: string } = {},
): Promise<RawResponse | null> {
  try {
    await opts.limiter?.acquire(url);
    const res = await opts.fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: init.accept ?? "application/json" },
      redirect: init.redirect ?? "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    return {
      status: res.status,
      url: res.url || url,
      location: res.headers.get("location"),
      text: () => res.text(),
    };
  } catch {
    return null; // network error or timeout: no signal either way
  }
}

const SAFE_SEGMENT = /^(?:[A-Za-z0-9._-]|%20)+$/;
function safe(v: string | null | undefined): v is string {
  return (
    typeof v === "string" &&
    v.length > 0 &&
    v.split("/").every((s) => s.length > 0 && SAFE_SEGMENT.test(s) && !s.includes(".."))
  );
}

const api = (verdict: LivenessVerdict, code: string, reason: string): LivenessResult => ({
  verdict,
  code,
  reason,
  via: "api",
});

/** Plain "200 means live, 404/410 means gone" APIs. Null when the answer is anything else. */
async function statusRung(
  url: string,
  ats: string,
  opts: LivenessOptions,
  authoritative404: boolean,
): Promise<LivenessResult | null> {
  const r = await rawGet(url, opts);
  if (!r) return null;
  if (r.status === 200) return api("active", `${ats}_api_ok`, "the board's API still lists it");
  if ((r.status === 404 || r.status === 410) && authoritative404)
    return api("expired", `${ats}_api_gone`, `the board's API says HTTP ${r.status}: removed`);
  return null;
}

async function greenhouseRung(
  ref: LivenessRef,
  opts: LivenessOptions,
): Promise<LivenessResult | null> {
  let board = ref.boardToken;
  let id = ref.atsJobId;
  const u = new URL(ref.applyUrl);
  if (/(^|\.)greenhouse\.io$/i.test(u.hostname)) {
    const m = /^\/([^/]+)\/jobs\/(\d+)\/?$/.exec(u.pathname);
    if (m) [board, id] = [m[1]!, m[2]!];
  }
  if (!board && id && /^\d+$/.test(id)) {
    // A company page with ?gh_jid=N: Greenhouse's embed URL redirects to the real board.
    const r = await rawGet(
      `https://boards.greenhouse.io/embed/job_app?token=${encodeURIComponent(id)}`,
      opts,
      { accept: "text/html" },
    );
    if (r && r.status >= 300 && r.status < 400 && r.location) {
      try {
        const to = new URL(r.location, "https://boards.greenhouse.io");
        if (
          to.protocol === "https:" &&
          /(^|\.)greenhouse\.io$/.test(to.hostname) &&
          to.searchParams.get("token") === id
        )
          board = to.searchParams.get("for");
      } catch {
        /* not a usable redirect */
      }
    }
  }
  if (!safe(board) || !safe(id) || !/^\d+$/.test(id)) return null;
  return statusRung(
    `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`,
    "greenhouse",
    opts,
    true,
  );
}

async function leverRung(ref: LivenessRef, opts: LivenessOptions): Promise<LivenessResult | null> {
  const u = new URL(ref.applyUrl);
  const host = /^jobs\.((?:eu\.)?lever\.co)$/i.exec(u.hostname)?.[1];
  const m = /^\/([^/]+)\/([^/?#]+)(?:\/apply)?\/?$/.exec(u.pathname);
  if (!host || !m || !safe(m[1]) || !safe(m[2])) return null;
  // Lever's API 404s confidential postings the page still serves, so a 404 decides nothing.
  return statusRung(`https://api.${host}/v0/postings/${m[1]}/${m[2]}`, "lever", opts, false);
}

async function ashbyRung(ref: LivenessRef, opts: LivenessOptions): Promise<LivenessResult | null> {
  const u = new URL(ref.applyUrl);
  if (u.hostname !== "jobs.ashbyhq.com") return null;
  const m = /^\/([^/]+)\/([^/]+)(?:\/application)?\/?$/.exec(u.pathname);
  if (!m || !safe(m[1]) || !safe(m[2])) return null;
  const url = `https://api.ashbyhq.com/posting-api/job-board/${m[1]}`;
  type Board = { jobs: { id?: string; isListed?: boolean }[] };
  let board = opts.boardCache?.get(url) as Board | undefined;
  if (!board) {
    const r = await rawGet(url, { ...opts, timeoutMs: opts.timeoutMs ?? 20_000 });
    if (!r || r.status !== 200) return null; // a 404 means a wrong slug or the API turned off
    let parsed: Partial<Board> | null;
    try {
      parsed = JSON.parse(await r.text()) as Partial<Board> | null;
    } catch {
      return null;
    }
    if (!parsed || !Array.isArray(parsed.jobs)) return null;
    board = { jobs: parsed.jobs };
    opts.boardCache?.set(url, board);
  }
  const target = m[2]!.toLowerCase();
  const job = board.jobs.find((j) => typeof j?.id === "string" && j.id.toLowerCase() === target);
  if (job && job.isListed !== false)
    return api("active", "ashby_api_ok", "listed on the Ashby board");
  return api("expired", "ashby_api_unlisted", "no longer listed on the company's Ashby board");
}

async function workdayRung(
  ref: LivenessRef,
  opts: LivenessOptions,
): Promise<LivenessResult | null> {
  const url = workdayDetailUrl(ref.applyUrl);
  if (!url) return null;
  const r = await rawGet(url, opts);
  if (!r) return null;
  if (r.status === 200) return api("active", "workday_api_ok", "Workday still serves the job");
  if (r.status === 404 || r.status === 410)
    return api("expired", "workday_api_gone", `Workday says HTTP ${r.status}: removed`);
  if (r.status === 403) {
    // Workday answers a withdrawn requisition with 403 and error code S22.
    try {
      const j = JSON.parse(await r.text()) as { httpStatus?: number; errorCode?: string };
      if (j.httpStatus === 403 && j.errorCode === "S22")
        return api("expired", "workday_api_withdrawn", "Workday says the job was withdrawn");
    } catch {
      /* a firewall page, not Workday's answer */
    }
  }
  return null;
}

async function smartRecruitersRung(
  ref: LivenessRef,
  opts: LivenessOptions,
): Promise<LivenessResult | null> {
  const u = new URL(ref.applyUrl);
  if (u.hostname !== "jobs.smartrecruiters.com") return null;
  const m = /^\/([^/]+)\/([A-Za-z0-9]+)(?:-[^/]*)?\/?$/.exec(u.pathname);
  if (!m || !safe(m[1]) || !safe(m[2])) return null;
  const r = await rawGet(
    `https://api.smartrecruiters.com/v1/companies/${m[1]}/postings/${m[2]}`,
    opts,
  );
  // The API also 404s (or 400s) ids it doesn't know, so only a readable answer counts.
  if (!r || r.status !== 200) return null;
  try {
    const p = JSON.parse(await r.text()) as { id?: unknown; active?: unknown };
    if (String(p.id) !== m[2] || typeof p.active !== "boolean") return null;
    return p.active
      ? api("active", "smartrecruiters_api_active", "SmartRecruiters says it's active")
      : api(
          "expired",
          "smartrecruiters_api_inactive",
          "SmartRecruiters says it's no longer active",
        );
  } catch {
    return null;
  }
}

/** The job board's API verdict, or null when it has nothing definite to say. */
export async function checkViaApi(
  ref: LivenessRef,
  opts: LivenessOptions,
): Promise<LivenessResult | null> {
  let ats = ref.ats;
  try {
    new URL(ref.applyUrl);
  } catch {
    return null;
  }
  if (ats === "other") ats = parseAtsUrl(ref.applyUrl).ats;
  try {
    switch (ats) {
      case "greenhouse":
        return await greenhouseRung(ref, opts);
      case "lever":
        return await leverRung(ref, opts);
      case "ashby":
        return await ashbyRung(ref, opts);
      case "workday":
        return await workdayRung(ref, opts);
      case "smartrecruiters":
        return await smartRecruitersRung(ref, opts);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Fetch the page itself (no scripts run) and classify what it says. */
export async function checkViaPage(url: string, opts: LivenessOptions): Promise<LivenessResult> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { verdict: "uncertain", code: "bad_url", reason: "not a URL", via: "page" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    return { verdict: "uncertain", code: "bad_url", reason: "not a web URL", via: "page" };
  const r = await rawGet(url, opts, { redirect: "follow", accept: "text/html" });
  if (!r)
    return {
      verdict: "uncertain",
      code: "network_error",
      reason: "couldn't load the page",
      via: "page",
    };
  let html = "";
  try {
    html = (await r.text()).slice(0, 2_000_000);
  } catch {
    /* body unreadable: classify on status alone */
  }
  return classifyPage({
    status: r.status,
    requestedUrl: url,
    finalUrl: r.url,
    ...pageEvidenceFromHtml(html),
  });
}

/**
 * Is this posting still open? The ATS API answers first; if it has nothing definite to say the
 * page is read. Only "expired" should ever close a posting; "uncertain" keeps it.
 */
export async function checkPostingOpen(
  ref: LivenessRef,
  opts: LivenessOptions,
): Promise<LivenessResult> {
  return (await checkViaApi(ref, opts)) ?? (await checkViaPage(ref.applyUrl, opts));
}
