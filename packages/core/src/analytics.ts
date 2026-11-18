import type { ApplicationStatus } from "./status.ts";
import { isSubmittedOrLater, NO_RESPONSE_DAYS } from "./status.ts";

export interface OutcomeRow {
  id: number;
  company: string;
  title: string;
  status: ApplicationStatus;
  tier: string;
  score: number | null;
  ats: string;
  sources: string[];
  roleFamily: string;
  submittedAt: string | null;
  nextAction: string | null;
  nextActionDue: string | null;
  contact: string | null;
}

export interface RateRow {
  key: string;
  submitted: number;
  /** Any reply, rejections included. */
  responded: number;
  /** Assessment, interview or offer. */
  positive: number;
  rate: number;
  positiveRate: number;
}

const RESPONDED: ApplicationStatus[] = ["online_assessment", "interview", "offer", "rejected"];
const POSITIVE: ApplicationStatus[] = ["online_assessment", "interview", "offer"];

export function scoreBand(score: number | null): string {
  if (score == null) return "unscored";
  if (score >= 90) return "90+";
  const lo = Math.floor(score / 10) * 10;
  return `${lo}-${lo + 9}`;
}

function rates(rows: OutcomeRow[], keyOf: (r: OutcomeRow) => string): RateRow[] {
  const groups = new Map<string, OutcomeRow[]>();
  for (const r of rows) groups.set(keyOf(r), [...(groups.get(keyOf(r)) ?? []), r]);
  return [...groups.entries()]
    .map(([key, g]) => {
      const responded = g.filter((r) => RESPONDED.includes(r.status)).length;
      const positive = g.filter((r) => POSITIVE.includes(r.status)).length;
      return {
        key,
        submitted: g.length,
        responded,
        positive,
        rate: g.length ? responded / g.length : 0,
        positiveRate: g.length ? positive / g.length : 0,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

export interface Suggestion {
  applicationId: number;
  kind: "mark_no_response" | "follow_up";
  text: string;
}

export interface OutcomeReport {
  totals: Record<string, number>;
  byTier: RateRow[];
  bySource: RateRow[];
  byAts: RateRow[];
  byScoreBand: RateRow[];
  byRoleFamily: RateRow[];
  dueSoon: {
    id: number;
    company: string;
    title: string;
    nextAction: string | null;
    nextActionDue: string;
  }[];
  suggestions: Suggestion[];
}

const DAY = 86_400_000;

/**
 * Response rates by tier, source, ATS, score band and role family, so the fit threshold can be
 * tuned on evidence; plus what's due this week and gentle suggestions. Nothing is changed here.
 */
export function outcomeReport(all: OutcomeRow[], now: Date = new Date()): OutcomeReport {
  const sent = all.filter(
    (r) => isSubmittedOrLater(r.status) || r.status === "withdrawn" || r.status === "no_response",
  );
  const totals: Record<string, number> = {};
  for (const r of all) totals[r.status] = (totals[r.status] ?? 0) + 1;
  totals.sent = sent.length;

  const weekOut = new Date(now.getTime() + 7 * DAY).toISOString().slice(0, 10);
  const dueSoon = all
    .filter((r) => r.nextActionDue && r.nextActionDue <= weekOut)
    .sort((a, b) => a.nextActionDue!.localeCompare(b.nextActionDue!))
    .map((r) => ({
      id: r.id,
      company: r.company,
      title: r.title,
      nextAction: r.nextAction,
      nextActionDue: r.nextActionDue!,
    }));

  const suggestions: Suggestion[] = [];
  for (const r of all) {
    if (r.status !== "submitted" || !r.submittedAt) continue;
    const days = (now.getTime() - Date.parse(r.submittedAt)) / DAY;
    if (days >= NO_RESPONSE_DAYS) {
      suggestions.push({
        applicationId: r.id,
        kind: "mark_no_response",
        text: `${r.company}: no news in ${Math.floor(days)} days. Mark as no response?`,
      });
    } else if (days >= 14 && r.contact && !r.nextAction) {
      suggestions.push({
        applicationId: r.id,
        kind: "follow_up",
        text: `${r.company}: two weeks since you applied. A short note to ${r.contact}?`,
      });
    }
  }

  return {
    totals,
    byTier: rates(sent, (r) => r.tier),
    bySource: rates(sent, (r) =>
      r.sources.some((s) => s !== "simplify" && s !== "manual")
        ? "job-board API"
        : (r.sources[0] ?? "unknown"),
    ),
    byAts: rates(sent, (r) => r.ats),
    byScoreBand: rates(sent, (r) => scoreBand(r.score)),
    byRoleFamily: rates(sent, (r) => r.roleFamily),
    dueSoon,
    suggestions,
  };
}
