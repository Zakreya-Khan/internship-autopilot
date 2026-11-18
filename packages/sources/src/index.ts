import type { Posting, RawPosting, WatchlistEntry } from "@ia/core";
import type { z } from "zod";
import { fetchAshbyBoard } from "./ashby.ts";
import { fetchGreenhouseBoard } from "./greenhouse.ts";
import type { FetchFn } from "./http.ts";
import { HostRateLimiter } from "./http.ts";
import { fetchLeverSite } from "./lever.ts";
import { fetchSimplify } from "./simplify.ts";
import { fetchSmartRecruitersBoard } from "./smartrecruiters.ts";
import { fetchWorkdayBoard, parseWorkdayUrl } from "./workday.ts";

export * from "./ashby.ts";
export * from "./enrich.ts";
export * from "./greenhouse.ts";
export * from "./http.ts";
export * from "./lever.ts";
export * from "./liveness.ts";
export * from "./simplify.ts";
export * from "./smartrecruiters.ts";
export * from "./workday.ts";

export const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface BoardResult {
  /** e.g. "greenhouse:exampleco", or "workday:example/External" */
  board: string;
  postings: RawPosting[];
  error: string | null;
  /** Does a stored posting belong to this board? Used to close roles the board stopped listing. */
  owns: (p: Pick<Posting, "ats" | "boardToken" | "applyUrl">) => boolean;
}

export interface PollResult {
  simplify: RawPosting[];
  simplifyError: string | null;
  boards: BoardResult[];
}

export function boardKey(ats: string, token: string): string {
  return `${ats}:${token.toLowerCase()}`;
}

type WatchlistInput = z.input<typeof WatchlistEntry>;

/** The board key and ownership test for one watchlist entry. */
export function boardFor(w: WatchlistInput): Pick<BoardResult, "board" | "owns"> {
  if (w.ats === "workday") {
    const site = w.url ? parseWorkdayUrl(w.url) : null;
    if (!site) return { board: `workday:${w.url ?? "?"}`, owns: () => false };
    return {
      board: `workday:${site.tenant.toLowerCase()}/${site.site}`,
      owns: (p) => {
        const s = p.ats === "workday" ? parseWorkdayUrl(p.applyUrl) : null;
        return Boolean(
          s && s.host === site.host && s.site.toLowerCase() === site.site.toLowerCase(),
        );
      },
    };
  }
  const board = boardKey(w.ats, w.token ?? "");
  return { board, owns: (p) => p.boardToken !== null && boardKey(p.ats, p.boardToken) === board };
}

/**
 * One polling pass over every public source. A failure on one board is recorded and the
 * rest carry on; nothing here retries forever or polls faster than the host limiter allows.
 */
export async function pollSources(opts: {
  fetch: FetchFn;
  watchlist: WatchlistInput[];
  now?: Date;
  includeSimplify?: boolean;
  limiter?: HostRateLimiter;
}): Promise<PollResult> {
  const limiter = opts.limiter ?? new HostRateLimiter(1000);
  const http = { fetch: opts.fetch, limiter };
  let simplify: RawPosting[] = [];
  let simplifyError: string | null = null;
  if (opts.includeSimplify !== false) {
    try {
      simplify = await fetchSimplify(http);
    } catch (e) {
      simplifyError = String(e);
    }
  }
  const boards: BoardResult[] = [];
  for (const w of opts.watchlist) {
    const { board, owns } = boardFor(w);
    const token = w.token ?? "";
    try {
      const postings =
        w.ats === "greenhouse"
          ? await fetchGreenhouseBoard(token, w.company, http)
          : w.ats === "lever"
            ? await fetchLeverSite(token, w.company, http)
            : w.ats === "ashby"
              ? await fetchAshbyBoard(token, w.company, http)
              : w.ats === "smartrecruiters"
                ? await fetchSmartRecruitersBoard(token, w.company, http)
                : await fetchWorkdayBoard(w.url ?? "", w.company, http, opts.now);
      boards.push({ board, postings, error: null, owns });
    } catch (e) {
      boards.push({ board, postings: [], error: String(e), owns });
    }
  }
  return { simplify, simplifyError, boards };
}
