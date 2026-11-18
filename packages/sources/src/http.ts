export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** Generic client name: no personal details go into requests to outside services. */
export const USER_AGENT = "internship-autopilot/0.1 (personal job search tool)";

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    method = "GET",
  ) {
    super(`${method} ${url} failed with HTTP ${status}`);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Per-host spacing between requests. Shared by every fetcher so a poll of many boards
 * on one host (e.g. boards-api.greenhouse.io) stays polite.
 */
export class HostRateLimiter {
  private readonly next = new Map<string, number>();
  constructor(
    private readonly minGapMs = 1000,
    private readonly now: () => number = Date.now,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {}

  async acquire(url: string): Promise<void> {
    const host = new URL(url).host;
    const t = this.now();
    const at = Math.max(t, this.next.get(host) ?? 0);
    this.next.set(host, at + this.minGapMs);
    if (at > t) await this.wait(at - t);
  }
}

export interface GetJsonOptions {
  fetch: FetchFn;
  limiter?: HostRateLimiter;
  retries?: number;
  timeoutMs?: number;
  backoffMs?: number;
  wait?: (ms: number) => Promise<void>;
}

/** GET JSON with a timeout and retries on 429 / 5xx / network errors, with exponential backoff. */
export async function getJson<T>(url: string, opts: GetJsonOptions): Promise<T> {
  return requestWith<T>(url, opts, undefined, "application/json", (r) => r.json() as Promise<T>);
}

/** GET a page as text, with the same spacing, timeout and retries as getJson. */
export async function getText(url: string, opts: GetJsonOptions): Promise<string> {
  return requestWith<string>(url, opts, undefined, "text/html,application/xhtml+xml", (r) =>
    r.text(),
  );
}

/** POST a JSON body and read JSON back, with the same spacing, timeout and retries as getJson. */
export async function postJson<T>(url: string, body: unknown, opts: GetJsonOptions): Promise<T> {
  return requestWith<T>(url, opts, body, "application/json", (r) => r.json() as Promise<T>);
}

async function requestWith<T>(
  url: string,
  opts: GetJsonOptions,
  body: unknown,
  accept: string,
  read: (res: Response) => Promise<T>,
): Promise<T> {
  const method = body === undefined ? "GET" : "POST";
  const retries = opts.retries ?? 3;
  const wait = opts.wait ?? sleep;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await opts.limiter?.acquire(url);
    try {
      const res = await opts.fetch(url, {
        method,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: accept,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      });
      if (res.ok) return await read(res);
      if (res.status !== 429 && res.status < 500) throw new HttpError(url, res.status, method);
      lastError = new HttpError(url, res.status, method);
      const retryAfter = Number(res.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        await wait(Math.min(retryAfter, 120) * 1000);
        continue;
      }
    } catch (e) {
      if (e instanceof HttpError && e.status !== 429 && e.status < 500) throw e;
      lastError = e;
    }
    if (attempt < retries) await wait((opts.backoffMs ?? 2000) * 2 ** attempt);
  }
  throw lastError;
}
