import type { RoleFamily } from "./profile.ts";

export const ATS_LIST = [
  "greenhouse",
  "lever",
  "ashby",
  "workday",
  "smartrecruiters",
  "icims",
  "other",
] as const;
export type Ats = (typeof ATS_LIST)[number];

export type SourceName = "simplify" | "greenhouse" | "lever" | "ashby" | "manual";

export type Sponsorship = "offers" | "no_sponsorship" | "citizenship_required" | "unknown";

export type QuestionType =
  | "text"
  | "textarea"
  | "select"
  | "multi_select"
  | "checkbox"
  | "radio"
  | "file"
  | "date"
  | "number"
  | "unknown";

/** One question on an application form, as an API or an adapter reports it. */
export interface FormQuestion {
  /** Stable key within the form: an API field name, or a slug of the label. */
  key: string;
  label: string;
  required: boolean;
  type: QuestionType;
  options?: string[];
  maxLength?: number | null;
}

export interface Posting {
  /** Stable id: `${ats}:${boardToken}:${atsJobId}` when known, else `url:${canonicalUrl}`. */
  id: string;
  company: string;
  title: string;
  locations: string[];
  ats: Ats;
  boardToken: string | null;
  atsJobId: string | null;
  applyUrl: string;
  sourceLinks: string[];
  sources: SourceName[];
  descriptionText: string | null;
  terms: string[];
  category: string | null;
  roleFamily: RoleFamily;
  degrees: string[];
  sponsorship: Sponsorship;
  deadline: string | null;
  /** When the employer posted it, if a source says. Freshness uses this before firstSeen. */
  postedAt: string | null;
  firstSeen: string;
  lastSeen: string;
  isOpen: boolean;
  /** Polls in a row on which an API source no longer listed it. */
  missedPolls: number;
  questions: FormQuestion[] | null;
}

/** What a source fetcher returns before ids, dedupe and timestamps are applied. */
export type RawPosting = Omit<
  Posting,
  "id" | "firstSeen" | "lastSeen" | "missedPolls" | "roleFamily" | "questions"
> & {
  roleFamily?: RoleFamily;
  questions?: FormQuestion[] | null;
};
