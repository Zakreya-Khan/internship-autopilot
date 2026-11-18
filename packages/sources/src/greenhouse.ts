import {
  decodeEntities,
  detectSponsorship,
  detectTerms,
  htmlToText,
  isInternshipTitle,
} from "@ia/core";
import type { FormQuestion, QuestionType, RawPosting } from "@ia/core";
import type { GetJsonOptions } from "./http.ts";
import { getJson } from "./http.ts";

const API = "https://boards-api.greenhouse.io/v1/boards";

interface GhJob {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string | null } | null;
  content?: string | null;
  company_name?: string | null;
  first_published?: string | null;
  application_deadline?: string | null;
}

interface GhField {
  name: string;
  type: string;
  values?: { label: string; value: string | number }[];
}

interface GhQuestion {
  label: string;
  required?: boolean;
  description?: string | null;
  fields: GhField[];
}

interface GhJobDetail extends GhJob {
  questions?: GhQuestion[];
  location_questions?: GhQuestion[];
  compliance?: { type?: string; questions?: GhQuestion[] }[] | null;
  demographic_questions?: {
    questions?: {
      id: number;
      label: string;
      required?: boolean;
      type?: string;
      answer_options?: { label: string }[];
    }[];
  } | null;
}

const TYPE_MAP: Record<string, QuestionType> = {
  input_text: "text",
  textarea: "textarea",
  input_file: "file",
  multi_value_single_select: "select",
  multi_value_multi_select: "multi_select",
  input_hidden: "unknown",
};

function ghContentToText(content: string | null | undefined): string | null {
  if (!content) return null;
  return htmlToText(decodeEntities(content));
}

export function mapGreenhouseJob(job: GhJob, token: string, companyFallback: string): RawPosting {
  const description = ghContentToText(job.content);
  return {
    company: job.company_name || companyFallback,
    title: job.title,
    locations: job.location?.name ? job.location.name.split(/\s*;\s*/) : [],
    ats: "greenhouse",
    boardToken: token,
    atsJobId: String(job.id),
    applyUrl: job.absolute_url,
    sourceLinks: [`${API}/${token}/jobs/${job.id}`],
    sources: ["greenhouse"],
    descriptionText: description,
    terms: detectTerms(`${job.title}\n${description ?? ""}`),
    category: null,
    degrees: [],
    sponsorship: detectSponsorship(null, description),
    deadline: job.application_deadline ? job.application_deadline.slice(0, 10) : null,
    postedAt: job.first_published ?? null,
    isOpen: true,
  };
}

/** All internship-like postings on one board. Full descriptions come back in the same call. */
export async function fetchGreenhouseBoard(
  token: string,
  company: string,
  opts: GetJsonOptions,
): Promise<RawPosting[]> {
  const data = await getJson<{ jobs: GhJob[] }>(
    `${API}/${encodeURIComponent(token)}/jobs?content=true`,
    opts,
  );
  return data.jobs
    .filter((j) => isInternshipTitle(j.title))
    .map((j) => mapGreenhouseJob(j, token, company));
}

function mapQuestion(q: GhQuestion): FormQuestion[] {
  return q.fields
    .filter((f) => f.type !== "input_hidden")
    .map((f) => {
      const type = TYPE_MAP[f.type] ?? "unknown";
      const options = f.values?.map((v) => v.label);
      return {
        key: f.name,
        label: q.label,
        required: Boolean(q.required),
        type,
        ...(options && options.length ? { options } : {}),
      };
    });
}

/**
 * The application form for one job, before any browser opens. Custom questions, location
 * questions, and the EEO/compliance block (filled only from your saved choices).
 */
export async function fetchGreenhouseQuestions(
  token: string,
  jobId: string,
  opts: GetJsonOptions,
): Promise<FormQuestion[]> {
  return (await fetchGreenhouseDetail(token, jobId, opts)).questions;
}

/** One job with its description and its full application form. */
export async function fetchGreenhouseDetail(
  token: string,
  jobId: string,
  opts: GetJsonOptions,
): Promise<{ descriptionText: string | null; questions: FormQuestion[]; deadline: string | null }> {
  const d = await getJson<GhJobDetail>(
    `${API}/${encodeURIComponent(token)}/jobs/${encodeURIComponent(jobId)}?questions=true`,
    opts,
  );
  return {
    descriptionText: ghContentToText(d.content),
    questions: mapDetailQuestions(d),
    deadline: d.application_deadline ? d.application_deadline.slice(0, 10) : null,
  };
}

function mapDetailQuestions(d: GhJobDetail): FormQuestion[] {
  const out: FormQuestion[] = [];
  for (const q of [...(d.questions ?? []), ...(d.location_questions ?? [])])
    out.push(...mapQuestion(q));
  for (const block of d.compliance ?? []) {
    for (const q of block.questions ?? [])
      out.push(...mapQuestion(q).map((x) => ({ ...x, key: `eeo:${x.key}` })));
  }
  for (const q of d.demographic_questions?.questions ?? []) {
    out.push({
      key: `demographic:${q.id}`,
      label: q.label,
      required: Boolean(q.required),
      type: q.type === "multi_value_multi_select" ? "multi_select" : "select",
      options: (q.answer_options ?? []).map((o) => o.label),
    });
  }
  return out;
}
