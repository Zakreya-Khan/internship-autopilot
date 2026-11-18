import type { Posting } from "@ia/core";
import type { FetchFn, LivenessResult } from "@ia/sources";
import { checkPostingOpen, HostRateLimiter } from "@ia/sources";
import type { Store } from "./db.ts";

/** Asks whether one posting is still open. Injected so tests and offline runs can replace it. */
export type LivenessCheck = (p: Posting) => Promise<LivenessResult>;

/** The real check: public board APIs and pages, spaced by the shared per-host limiter. */
export function makeLivenessCheck(
  fetch: FetchFn,
  limiter: HostRateLimiter = new HostRateLimiter(1000),
): LivenessCheck {
  const boardCache = new Map<string, unknown>();
  return (p) => checkPostingOpen(p, { fetch, limiter, boardCache });
}

/** Before prep: a day-old answer is fine. Before a fill session: recheck after 6 hours. */
export const PREP_RECHECK_MS = 24 * 60 * 60 * 1000;
export const SESSION_RECHECK_MS = 6 * 60 * 60 * 1000;

/**
 * Check a posting, reusing a recent stored answer. Expired answers are permanent. The result
 * is recorded, and an expired one closes the posting in the database.
 */
export async function ensureOpen(
  store: Store,
  posting: Posting,
  check: LivenessCheck,
  maxAgeMs: number,
  now: Date = new Date(),
): Promise<LivenessResult> {
  const prev = store.getLiveness(posting.id);
  if (
    prev &&
    (prev.verdict === "expired" || now.getTime() - Date.parse(prev.checked_at) < maxAgeMs)
  ) {
    return { verdict: prev.verdict, code: prev.code, reason: prev.reason, via: prev.via as "api" };
  }
  let r: LivenessResult;
  try {
    r = await check(posting);
  } catch (e) {
    r = { verdict: "uncertain", code: "check_failed", reason: String(e), via: "page" };
  }
  store.recordLiveness(posting.id, r);
  return r;
}
