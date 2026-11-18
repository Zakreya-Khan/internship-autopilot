// Type-only imports from @ia/core: nothing from the Node side is bundled into the UI.
import type {
  ApplicationStatus,
  FitScore,
  OutcomeReport,
  Qualification,
  ResumeDiff,
  Tier,
  TruthIssue,
} from "@ia/core";

export interface PostingSummary {
  id: string;
  company: string;
  title: string;
  locations: string[];
  ats: string;
  applyUrl: string;
  deadline: string | null;
  sponsorship: string;
  sourceLinks: string[];
}

export interface QualifyItem {
  postingId: string;
  company: string;
  title: string;
  applyUrl: string;
  locations: string[];
  tier: Tier | null;
  score: number | null;
  applicationId: number | null;
  qualification: Qualification;
}

export interface Flags {
  red: number;
  amber: number;
  grey: number;
}

export interface QueueItem {
  id: number;
  status: ApplicationStatus;
  tier: Tier;
  score: number | null;
  posting: PostingSummary;
  flags: Flags;
  updatedAt: string;
}

export interface Field {
  field_key: string;
  label: string;
  field_type: string;
  planned_value: string | null;
  source: "profile" | "bank" | "drafted" | "you" | "mapped";
  confidence: "high" | "medium" | "low";
  flag: "red" | "amber" | "grey" | null;
  note: string | null;
  required: boolean;
  options: string[] | null;
  attach: "resume" | "cover_letter" | null;
  value_seen: string | null;
}

export interface Draft {
  id: number;
  kind: "answer" | "cover_letter";
  question_key: string | null;
  question_text: string | null;
  text: string;
  cited_fact_ids: string[];
  checker_status: "pass" | "flagged";
  checker_notes: string[];
  edited_by_user: boolean;
}

export interface ApplicationRow {
  id: number;
  status: ApplicationStatus;
  tier: Tier;
  submitted_at: string | null;
  next_action: string | null;
  next_action_due: string | null;
  contact: string | null;
  notes: string | null;
  updated_at: string;
}

export interface Detail {
  application: ApplicationRow;
  posting: PostingSummary & { descriptionText: string | null };
  score: FitScore | null;
  resume: {
    diff: ResumeDiff;
    parseCheck: { ok: boolean; pages: number; missing: string[] };
    fitNote: { why: string; gaps: string } | null;
    issues: TruthIssue[];
    hasCoverLetter: boolean;
  } | null;
  drafts: Draft[];
  fields: Field[];
  flags: Flags;
  events: { at: string; type: string; payload: unknown }[];
}

export type TrackerRow = ApplicationRow & { posting: PostingSummary };

export type Stats = OutcomeReport & { cost: { purpose: string; calls: number; usd: number }[] };

function token(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="ia-token"]')?.content;
  if (meta) return meta;
  // Dev server only: the page isn't served by the local app, so ask once and remember.
  let t = "";
  try {
    t = localStorage.getItem("ia-token") ?? "";
  } catch {
    /* storage unavailable */
  }
  if (!t) {
    t = window.prompt("Paste the token printed by `npm run ia -- init`") ?? "";
    try {
      localStorage.setItem("ia-token", t);
    } catch {
      /* storage unavailable */
    }
  }
  return t;
}

export class ApiError extends Error {}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "x-ia-token": token(), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  queue: (status?: string) =>
    call<QueueItem[]>("GET", `/api/queue${status ? `?status=${status}` : ""}`),
  detail: (id: number) => call<Detail>("GET", `/api/applications/${id}`),
  setStatus: (id: number, to: ApplicationStatus, confirmedByUser = false) =>
    call<{ ok: true }>("POST", `/api/applications/${id}/status`, { to, confirmedByUser }),
  setField: (id: number, key: string, value: string) =>
    call<{ ok: true; status: ApplicationStatus }>(
      "PATCH",
      `/api/applications/${id}/fields/${encodeURIComponent(key)}`,
      { value },
    ),
  editDraft: (draftId: number, text: string) =>
    call<{ ok: true; status: ApplicationStatus }>("PATCH", `/api/drafts/${draftId}`, { text }),
  tracker: () => call<TrackerRow[]>("GET", "/api/tracker"),
  setTracking: (
    id: number,
    fields: Partial<Pick<ApplicationRow, "next_action" | "next_action_due" | "contact" | "notes">>,
  ) => call<{ ok: true }>("PATCH", `/api/applications/${id}/tracking`, fields),
  stats: () => call<Stats>("GET", "/api/stats"),
  qualify: (verdict: "meets" | "close") =>
    call<QualifyItem[]>("GET", `/api/qualify?verdict=${verdict}`),
  fileUrl: (id: number, kind: "resume" | "cover_letter") => `/api/applications/${id}/files/${kind}`,
};

/** PDFs need the token header too, so they are fetched and opened as a blob URL. */
export async function openPdf(id: number, kind: "resume" | "cover_letter"): Promise<void> {
  const res = await fetch(api.fileUrl(id, kind), { headers: { "x-ia-token": token() } });
  if (!res.ok) throw new ApiError(`Couldn't load the ${kind.replace("_", " ")}`);
  window.open(URL.createObjectURL(await res.blob()), "_blank", "noopener");
}

/** The tracker as CSV/TSV for Google Sheets or Excel (fetched with the token, saved as a file). */
export async function downloadExport(format: "csv" | "tsv"): Promise<void> {
  const res = await fetch(`/api/export.csv?format=${format}`, {
    headers: { "x-ia-token": token() },
  });
  if (!res.ok) throw new ApiError("Export failed");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(await res.blob());
  a.download = `applications.${format}`;
  document.body.append(a);
  a.dispatchEvent(new MouseEvent("click"));
  a.remove();
}
