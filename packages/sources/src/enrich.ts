import type { FormQuestion, Posting } from "@ia/core";
import { fetchGreenhouseDetail } from "./greenhouse.ts";
import type { GetJsonOptions } from "./http.ts";
import { getJson } from "./http.ts";
import { fetchLeverPosting } from "./lever.ts";
import { fetchSmartRecruitersDetail } from "./smartrecruiters.ts";
import { fetchWorkdayDetail, workdayDetailUrl } from "./workday.ts";

export interface PostingDetail {
  descriptionText: string | null;
  questions: FormQuestion[] | null;
  deadline: string | null;
  /** Only when the list call couldn't give them (Workday's "3 Locations"). */
  locations?: string[];
}

type DetailRef = Pick<Posting, "ats" | "boardToken" | "atsJobId"> & { applyUrl?: string };

export function canEnrich(p: DetailRef): boolean {
  if (p.ats === "workday") return Boolean(p.applyUrl && workdayDetailUrl(p.applyUrl));
  return (
    ["greenhouse", "lever", "ashby", "smartrecruiters"].includes(p.ats) &&
    Boolean(p.boardToken && p.atsJobId)
  );
}

/**
 * Description (and, for Greenhouse, the application form) for one posting, from the ATS's
 * public API. Ashby has no single-job endpoint, so one board read serves every job on it.
 */
export async function fetchPostingDetail(
  p: DetailRef,
  opts: GetJsonOptions,
  ashbyCache = new Map<string, Promise<{ jobs: { id: string; descriptionPlain?: string }[] }>>(),
): Promise<PostingDetail | null> {
  if (!canEnrich(p)) return null;
  if (p.ats === "workday") {
    const d = await fetchWorkdayDetail(p.applyUrl!, opts);
    return d
      ? {
          descriptionText: d.descriptionText,
          questions: null,
          deadline: d.deadline,
          ...(d.locations.length ? { locations: d.locations } : {}),
        }
      : null;
  }
  const token = p.boardToken!;
  const id = p.atsJobId!;
  if (p.ats === "greenhouse") return fetchGreenhouseDetail(token, id, opts);
  if (p.ats === "lever") {
    const d = await fetchLeverPosting(token, id, opts);
    return { ...d, questions: null, deadline: null };
  }
  if (p.ats === "smartrecruiters") {
    const d = await fetchSmartRecruitersDetail(token, id, opts);
    return { descriptionText: d.descriptionText, questions: null, deadline: null };
  }
  let board = ashbyCache.get(token);
  if (!board) {
    board = getJson(
      `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`,
      opts,
    );
    ashbyCache.set(token, board);
  }
  const job = (await board).jobs.find((j) => j.id === id);
  return job
    ? { descriptionText: job.descriptionPlain ?? null, questions: null, deadline: null }
    : null;
}
