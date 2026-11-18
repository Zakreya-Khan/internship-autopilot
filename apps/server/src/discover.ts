// Discover: every posting the sources found, searchable and filterable, for the review UI.
// And the home page's "what to do next" summary. Read-only.
import type { ApplicationStatus, Posting, Tier } from "@ia/core";
import { isSubmittedOrLater } from "@ia/core";
import type { Store } from "./db.ts";

export interface PostingQuery {
  /** Words in the company, title or location. */
  q?: string;
  tier?: Tier | "none";
  minScore?: number;
  company?: string;
  location?: string;
  /** Where it was found: "simplify", or a watchlist ATS like "greenhouse". */
  source?: string;
  open?: "open" | "closed" | "all";
  /** "passed": only postings that pass your filters (default). */
  filter?: "passed" | "dropped" | "all";
  /** "none": not started; "active": being prepared or ready; "submitted": sent; or one status. */
  status?: "none" | "active" | "submitted" | "any" | ApplicationStatus;
  sort?: "score" | "newest" | "deadline" | "company";
  offset?: number;
  limit?: number;
}

export interface PostingRow {
  id: string;
  company: string;
  title: string;
  locations: string[];
  ats: string;
  sources: string[];
  applyUrl: string;
  deadline: string | null;
  postedAt: string | null;
  firstSeen: string;
  isOpen: boolean;
  sponsorship: string;
  hasDescription: boolean;
  tier: Tier | null;
  score: number | null;
  passed: boolean | null;
  filterReasons: string[];
  application: { id: number; status: ApplicationStatus } | null;
  liveness: { verdict: string; reason: string; checkedAt: string } | null;
}

interface Joined {
  data: string;
  passed: number | null;
  filter_reasons: string | null;
  score: number | null;
  tier: string | null;
  app_id: number | null;
  app_status: string | null;
  l_verdict: string | null;
  l_reason: string | null;
  l_at: string | null;
}

function allRows(store: Store): PostingRow[] {
  const rows = store.db
    .prepare(
      `SELECT p.data, s.passed, s.filter_reasons, s.score, s.tier,
        a.id AS app_id, a.status AS app_status,
        l.verdict AS l_verdict, l.reason AS l_reason, l.checked_at AS l_at
      FROM postings p
      LEFT JOIN fit_scores s ON s.posting_id = p.id
      LEFT JOIN applications a ON a.posting_id = p.id
      LEFT JOIN liveness_checks l ON l.posting_id = p.id`,
    )
    .all() as unknown as Joined[];
  return rows.map((r) => {
    const p = JSON.parse(r.data) as Posting;
    return {
      id: p.id,
      company: p.company,
      title: p.title,
      locations: p.locations,
      ats: p.ats,
      sources: p.sources,
      applyUrl: p.applyUrl,
      deadline: p.deadline,
      postedAt: p.postedAt,
      firstSeen: p.firstSeen,
      isOpen: p.isOpen,
      sponsorship: p.sponsorship,
      hasDescription: Boolean(p.descriptionText),
      tier: (r.tier as Tier | null) ?? null,
      score: r.score ?? null,
      passed: r.passed === null ? null : r.passed === 1,
      filterReasons: r.filter_reasons ? (JSON.parse(r.filter_reasons) as string[]) : [],
      application:
        r.app_id === null ? null : { id: r.app_id, status: r.app_status as ApplicationStatus },
      liveness: r.l_verdict
        ? { verdict: r.l_verdict, reason: r.l_reason ?? "", checkedAt: r.l_at ?? "" }
        : null,
    };
  });
}

const ACTIVE: ApplicationStatus[] = ["prepared", "needs_input", "ready", "approved", "filled"];
const has = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase());

function matches(r: PostingRow, q: PostingQuery): boolean {
  if ((q.open ?? "open") === "open" && !r.isOpen) return false;
  if (q.open === "closed" && r.isOpen) return false;
  const filter = q.filter ?? "passed";
  if (filter === "passed" && r.passed !== true) return false;
  if (filter === "dropped" && r.passed !== false) return false;
  if (q.tier === "none" ? r.tier !== null : q.tier && r.tier !== q.tier) return false;
  if (q.minScore !== undefined && (r.score ?? -1) < q.minScore) return false;
  if (q.company && !has(r.company, q.company)) return false;
  if (q.location && !r.locations.some((l) => has(l, q.location!))) return false;
  if (q.source && !r.sources.includes(q.source) && r.ats !== q.source) return false;
  const s = r.application?.status ?? null;
  switch (q.status ?? "any") {
    case "any":
      break;
    case "none":
      if (s !== null) return false;
      break;
    case "active":
      if (!s || !ACTIVE.includes(s)) return false;
      break;
    case "submitted":
      if (!s || !isSubmittedOrLater(s)) return false;
      break;
    default:
      if (s !== q.status) return false;
  }
  if (q.q) {
    const words = q.q.trim().split(/\s+/).filter(Boolean);
    const text = `${r.company} ${r.title} ${r.locations.join(" ")}`;
    if (!words.every((w) => has(text, w))) return false;
  }
  return true;
}

const SORTS: Record<NonNullable<PostingQuery["sort"]>, (a: PostingRow, b: PostingRow) => number> = {
  score: (a, b) => (b.score ?? -1) - (a.score ?? -1) || a.company.localeCompare(b.company),
  newest: (a, b) =>
    (b.postedAt ?? b.firstSeen).localeCompare(a.postedAt ?? a.firstSeen) ||
    (b.score ?? -1) - (a.score ?? -1),
  deadline: (a, b) =>
    (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999") || (b.score ?? -1) - (a.score ?? -1),
  company: (a, b) => a.company.localeCompare(b.company) || a.title.localeCompare(b.title),
};

export function searchPostings(
  store: Store,
  q: PostingQuery,
): {
  total: number;
  offset: number;
  items: PostingRow[];
  sources: { name: string; count: number }[];
  counts: { all: number; open: number; passed: number };
} {
  const rows = allRows(store);
  const hits = rows.filter((r) => matches(r, q)).sort(SORTS[q.sort ?? "score"]);
  const offset = Math.max(0, q.offset ?? 0);
  const limit = Math.min(200, Math.max(1, q.limit ?? 50));
  const bySource = new Map<string, number>();
  for (const r of rows.filter((x) => x.isOpen))
    for (const s of new Set([...r.sources, r.ats])) bySource.set(s, (bySource.get(s) ?? 0) + 1);
  return {
    total: hits.length,
    offset,
    items: hits.slice(offset, offset + limit),
    sources: [...bySource]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    counts: {
      all: rows.length,
      open: rows.filter((r) => r.isOpen).length,
      passed: rows.filter((r) => r.isOpen && r.passed).length,
    },
  };
}

/** Skip postings you don't want: they get a "skipped" application and drop out of prep. */
export function skipPostings(store: Store, ids: string[]): { skipped: number; left: number } {
  let skipped = 0;
  let left = 0;
  for (const id of ids) {
    const p = store.getPosting(id);
    if (!p) continue;
    const existing = store.applicationForPosting(id);
    const tier = store.getScore(id)?.fit?.tier ?? "C";
    const app = existing ?? store.createApplication(id, tier);
    if (app.status === "skipped") continue;
    // Only work not yet sent can be skipped; approved/filled go back through review first.
    if (["prepared", "needs_input", "ready"].includes(app.status)) {
      store.setStatus(app.id, "skipped");
      skipped++;
    } else left++;
  }
  return { skipped, left };
}

/** Put skipped postings back: they return to "prepared" and the next prep run picks them up. */
export function unskipPostings(store: Store, ids: string[]): number {
  let n = 0;
  for (const id of ids) {
    const app = store.applicationForPosting(id);
    if (app?.status === "skipped") {
      store.setStatus(app.id, "prepared");
      n++;
    }
  }
  return n;
}

export interface HomeSummary {
  applications: Record<ApplicationStatus, number>;
  /** Pre-submit work: what the nav shows. */
  needsInput: number;
  ready: number;
  approved: number;
  filled: number;
  sent: number;
  postings: { open: number; passed: number; unstarted: number; unstartedAB: number };
  lastRefresh: string | null;
  openBatches: number;
  dueSoon: number;
}

export function homeSummary(store: Store, now = new Date()): HomeSummary {
  const statusRows = store.db
    .prepare("SELECT status, COUNT(*) AS n FROM applications GROUP BY status")
    .all() as { status: ApplicationStatus; n: number }[];
  const applications = Object.fromEntries(statusRows.map((r) => [r.status, Number(r.n)])) as Record<
    ApplicationStatus,
    number
  >;
  const n = (s: ApplicationStatus) => applications[s] ?? 0;
  const one = (sql: string, ...args: string[]) =>
    Number((store.db.prepare(sql).get(...args) as { n: number | null }).n ?? 0);
  const soon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const last = store.db.prepare("SELECT MAX(at) AS at FROM poll_runs").get() as {
    at: string | null;
  };
  return {
    applications,
    needsInput: n("needs_input"),
    ready: n("ready"),
    approved: n("approved"),
    filled: n("filled"),
    sent: statusRows.filter((r) => isSubmittedOrLater(r.status)).reduce((a, r) => a + r.n, 0),
    postings: {
      open: one("SELECT COUNT(*) AS n FROM postings WHERE is_open = 1"),
      passed: one(
        "SELECT COUNT(*) AS n FROM postings p JOIN fit_scores s ON s.posting_id = p.id WHERE p.is_open = 1 AND s.passed = 1",
      ),
      unstarted: one(
        `SELECT COUNT(*) AS n FROM postings p JOIN fit_scores s ON s.posting_id = p.id
        LEFT JOIN applications a ON a.posting_id = p.id
        WHERE p.is_open = 1 AND s.passed = 1 AND a.id IS NULL`,
      ),
      unstartedAB: one(
        `SELECT COUNT(*) AS n FROM postings p JOIN fit_scores s ON s.posting_id = p.id
        LEFT JOIN applications a ON a.posting_id = p.id
        WHERE p.is_open = 1 AND s.passed = 1 AND a.id IS NULL AND s.tier IN ('A', 'B')`,
      ),
    },
    lastRefresh: last.at ?? null,
    openBatches: store.openBatches().length,
    dueSoon: one(
      "SELECT COUNT(*) AS n FROM applications WHERE next_action_due IS NOT NULL AND next_action_due <= ?",
      soon,
    ),
  };
}
