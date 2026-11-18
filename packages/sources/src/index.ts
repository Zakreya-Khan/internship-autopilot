import type { RawPosting, WatchlistEntry } from "@ia/core";
import { fetchAshbyBoard } from "./ashby.ts";
import { fetchGreenhouseBoard } from "./greenhouse.ts";
import type { FetchFn } from "./http.ts";
import { HostRateLimiter } from "./http.ts";
import { fetchLeverSite } from "./lever.ts";
import { fetchSimplify } from "./simplify.ts";

export * from "./ashby.ts";
export * from "./enrich.ts";
export * from "./greenhouse.ts";
export * from "./http.ts";
export * from "./lever.ts";
export * from "./simplify.ts";

export const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface BoardResult {
  /** e.g. "greenhouse:exampleco" */
  board: string;
  postings: RawPosting[];
  error: string | null;
}

export interface PollResult {
  simplify: RawPosting[];
  simplifyError: string | null;
  boards: BoardResult[];
}

export function boardKey(ats: string, token: string): string {
  return `${ats}:${token.toLowerCase()}`;
}

/**
 * One polling pass over every public source. A failure on one board is recorded and the
 * rest carry on; nothing here retries forever or polls faster than the host limiter allows.
 */
export async function pollSources(opts: {
  fetch: FetchFn;
  watchlist: WatchlistEntry[];
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
    const board = boardKey(w.ats, w.token);
    try {
      const postings =
        w.ats === "greenhouse"
          ? await fetchGreenhouseBoard(w.token, w.company, http)
          : w.ats === "lever"
            ? await fetchLeverSite(w.token, w.company, http)
            : await fetchAshbyBoard(w.token, w.company, http);
      boards.push({ board, postings, error: null });
    } catch (e) {
      boards.push({ board, postings: [], error: String(e) });
    }
  }
  return { simplify, simplifyError, boards };
}
