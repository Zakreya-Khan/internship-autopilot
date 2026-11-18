import type { FillEntry } from "./fillplan.ts";
import type { Profile } from "./profile.ts";
import { classifyQuestion, questionKey, resolveKnownField } from "./questions.ts";
import type { FormQuestion } from "./types.ts";

/** A field found on a page no adapter knows, as the generic adapter reports it. */
export interface PageField {
  /** Stable handle the generic adapter set on the element (data-ia-key). */
  key: string;
  label: string;
  type: FormQuestion["type"];
  required: boolean;
  options?: string[];
}

export interface MappedField {
  key: string;
  label: string;
  type: FormQuestion["type"];
  required: boolean;
  options?: string[] | null;
  value: string | null;
  attach?: "resume" | "cover_letter" | null;
  /** How the value was chosen. Every mapped field on an unknown page is low confidence. */
  via: "same_label" | "profile_field" | "model" | "none";
}

/**
 * Match page fields to the prepared plan without a model: same label as a planned question,
 * or a field the profile answers directly. Values only ever come from the plan or the profile.
 */
export function mapPageFieldsByRules(
  page: PageField[],
  plan: { key: string; label: string; value: string | null; attach?: FillEntry["attach"] | null }[],
  profile: Profile,
): { mapped: MappedField[]; unmatched: PageField[] } {
  const byLabel = new Map(plan.map((p) => [questionKey(p.label), p]));
  const mapped: MappedField[] = [];
  const unmatched: PageField[] = [];
  for (const f of page) {
    const base = {
      key: f.key,
      label: f.label,
      type: f.type,
      required: f.required,
      options: f.options ?? null,
    };
    const same = byLabel.get(questionKey(f.label));
    if (same) {
      mapped.push({ ...base, value: same.value, attach: same.attach ?? null, via: "same_label" });
      continue;
    }
    const cls = classifyQuestion({ key: f.key, label: f.label, type: f.type });
    if (cls.kind === "known") {
      if (cls.field === "resume" || cls.field === "cover_letter") {
        mapped.push({
          ...base,
          value: null,
          attach: f.type === "file" ? cls.field : null,
          via: "profile_field",
        });
        continue;
      }
      const v = resolveKnownField(
        cls.field,
        { type: f.type, ...(f.options ? { options: f.options } : {}) },
        profile,
      );
      mapped.push({ ...base, value: v, via: v === null ? "none" : "profile_field" });
      continue;
    }
    if (cls.kind === "user_only") {
      mapped.push({ ...base, value: null, via: "none" });
      continue;
    }
    unmatched.push(f);
  }
  return { mapped, unmatched };
}
