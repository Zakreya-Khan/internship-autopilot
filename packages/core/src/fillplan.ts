import type { Profile } from "./profile.ts";
import { classifyQuestion, questionKey, resolveKnownField } from "./questions.ts";
import type { FormQuestion } from "./types.ts";

export type FillSource = "profile" | "bank" | "drafted" | "you" | "mapped";
export type Confidence = "high" | "medium" | "low";
export type Flag = "red" | "amber" | "grey" | null;

export interface FillEntry {
  key: string;
  label: string;
  type: FormQuestion["type"];
  required: boolean;
  options?: string[];
  value: string | null;
  source: FillSource;
  confidence: Confidence;
  flag: Flag;
  /** Shown beside the flag. */
  note: string | null;
  /** "resume" / "cover_letter" for file fields the extension attaches. */
  attach?: "resume" | "cover_letter";
}

export interface DraftedAnswer {
  questionKey: string;
  text: string;
  flagged: boolean;
}

/** The standard questions on ATSs whose forms aren't available ahead of time. */
export const STANDARD_QUESTIONS: Record<"lever" | "ashby" | "default", FormQuestion[]> = {
  lever: [
    { key: "resume", label: "Resume/CV", required: true, type: "file" },
    { key: "name", label: "Full name", required: true, type: "text" },
    { key: "email", label: "Email", required: true, type: "text" },
    { key: "phone", label: "Phone", required: false, type: "text" },
    { key: "location", label: "Current location", required: false, type: "text" },
    { key: "org", label: "Current company", required: false, type: "text" },
    { key: "urls[LinkedIn]", label: "LinkedIn URL", required: false, type: "text" },
    { key: "urls[GitHub]", label: "GitHub URL", required: false, type: "text" },
    { key: "urls[Portfolio]", label: "Portfolio URL", required: false, type: "text" },
    { key: "comments", label: "Additional information", required: false, type: "textarea" },
  ],
  ashby: [
    { key: "_systemfield_name", label: "Name", required: true, type: "text" },
    { key: "_systemfield_email", label: "Email", required: true, type: "text" },
    { key: "_systemfield_phone", label: "Phone", required: false, type: "text" },
    { key: "_systemfield_resume", label: "Resume", required: true, type: "file" },
    { key: "_systemfield_linkedin", label: "LinkedIn", required: false, type: "text" },
    { key: "_systemfield_github", label: "GitHub", required: false, type: "text" },
  ],
  default: [
    { key: "first_name", label: "First Name", required: true, type: "text" },
    { key: "last_name", label: "Last Name", required: true, type: "text" },
    { key: "email", label: "Email", required: true, type: "text" },
    { key: "phone", label: "Phone", required: false, type: "text" },
    { key: "resume", label: "Resume/CV", required: true, type: "file" },
    { key: "linkedin", label: "LinkedIn Profile", required: false, type: "text" },
  ],
};

/**
 * Turn a form's questions into a fill plan. Every value carries where it came from;
 * anything that can't be answered truthfully is left empty and flagged.
 */
export function buildFillPlan(
  questions: FormQuestion[],
  profile: Profile,
  drafted: Map<string, DraftedAnswer>,
  learned: Map<string, { answer: string }>,
  opts: { coverLetter?: boolean } = {},
): FillEntry[] {
  return questions.map((q): FillEntry => {
    const base = {
      key: q.key,
      label: q.label,
      type: q.type,
      required: q.required,
      ...(q.options ? { options: q.options } : {}),
    };
    const learnedAnswer = learned.get(questionKey(q.label));
    const cls = classifyQuestion(q);

    if (cls.kind === "known") {
      if ((cls.field === "resume" || cls.field === "cover_letter") && q.type !== "file") {
        // Greenhouse's "or paste it as text" box: the file is attached, so this stays empty.
        return {
          ...base,
          value: null,
          source: "profile",
          confidence: "high",
          flag: null,
          note: "Not needed: the file is attached.",
        };
      }
      if (cls.field === "resume") {
        return {
          ...base,
          value: null,
          source: "profile",
          confidence: "high",
          flag: null,
          note: null,
          attach: "resume",
        };
      }
      if (cls.field === "cover_letter") {
        return opts.coverLetter
          ? {
              ...base,
              value: null,
              source: "drafted",
              confidence: "medium",
              flag: null,
              note: null,
              attach: "cover_letter",
            }
          : {
              ...base,
              value: null,
              source: "profile",
              confidence: "high",
              flag: q.required ? "red" : "grey",
              note: q.required
                ? "A cover letter is required here."
                : "Optional cover letter skipped.",
            };
      }
      const value = resolveKnownField(cls.field, q, profile);
      if (value !== null)
        return {
          ...base,
          value,
          source: "profile",
          confidence: q.options?.length ? "medium" : "high",
          flag: null,
          note: null,
        };
      if (learnedAnswer)
        return {
          ...base,
          value: learnedAnswer.answer,
          source: "you",
          confidence: "high",
          flag: null,
          note: null,
        };
      return {
        ...base,
        value: null,
        source: "profile",
        confidence: "low",
        flag: q.required ? "red" : "amber",
        note: q.options?.length
          ? "None of the options matches your profile exactly."
          : "Your profile has no value for this.",
      };
    }
    if (cls.kind === "user_only") {
      return {
        ...base,
        value: null,
        source: "you",
        confidence: "high",
        flag: "grey",
        note: "Left for you to tick yourself.",
      };
    }
    if (learnedAnswer)
      return {
        ...base,
        value: learnedAnswer.answer,
        source: "you",
        confidence: "high",
        flag: null,
        note: null,
      };
    if (cls.kind === "open") {
      const d = drafted.get(q.key);
      if (d) {
        return {
          ...base,
          value: d.text,
          source: "drafted",
          confidence: d.flagged ? "low" : "medium",
          flag: d.flagged ? "red" : null,
          note: d.flagged ? "The truth check flagged this draft." : null,
        };
      }
      return {
        ...base,
        value: null,
        source: "drafted",
        confidence: "low",
        flag: q.required ? "red" : "amber",
        note: "No draft yet.",
      };
    }
    return {
      ...base,
      value: null,
      source: "you",
      confidence: "low",
      flag: q.required ? "red" : "amber",
      note: `Needs you: ${cls.reason}.`,
    };
  });
}

export function hasBlockingFlags(plan: Pick<FillEntry, "flag">[]): boolean {
  return plan.some((f) => f.flag === "red");
}
