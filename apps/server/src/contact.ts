// Contact details always come from the current profile. A fill plan and a tailored resume keep a
// copy made at prep time, so when profile.yaml changes (a new email, phone or link), every
// application not yet submitted is brought up to date here: no model calls, and nothing you
// typed yourself is touched. Values are never logged.
import { existsSync, writeFileSync } from "node:fs";
import type { Profile, ResumeDoc } from "@ia/core";
import { buildBaseResume, contactFieldOf, isSubmittedOrLater, resolveKnownField } from "@ia/core";
import { parseCheckResume, renderResumePdf } from "@ia/render";
import { refreshReadiness } from "./answers.ts";
import type { Store } from "./db.ts";
import { resumePathFor } from "./prep.ts";

export interface ContactSync {
  /** Applications where something changed. */
  applications: number[];
  /** Form fields given the current value. */
  fields: number;
  /** Resume PDFs re-rendered with the current header. */
  resumes: number;
  /** Approved applications sent back for review because a required contact value is now missing. */
  sentBack: number[];
}

/**
 * Bring contact fields and resume headers up to date with `profile`, for the given applications
 * (default: every one not yet submitted). Approved applications stay approved: only values that
 * came from your profile change, to what your profile now says.
 */
export async function syncContactDetails(
  store: Store,
  profile: Profile,
  outDir: string,
  ids?: number[],
): Promise<ContactSync> {
  const out: ContactSync = { applications: [], fields: 0, resumes: 0, sentBack: [] };
  const apps = ids
    ? ids.map((id) => store.getApplication(id)).filter((a) => a !== null)
    : store.listApplications();
  const header = buildBaseResume(profile).header;
  for (const a of apps) {
    if (isSubmittedOrLater(a.status)) continue;
    let fields = 0;
    let missingRequired = false;
    for (const f of store.listFieldFills(a.id)) {
      if (f.source !== "profile") continue;
      const field = contactFieldOf({ key: f.field_key, label: f.label, type: f.field_type });
      if (!field) continue;
      const value =
        resolveKnownField(
          field,
          { type: f.field_type, ...(f.options ? { options: f.options } : {}) },
          profile,
        ) || null; // an empty value in the profile is no value
      if (value === (f.planned_value || null)) continue;
      if (value === null) {
        if (f.required) missingRequired = true;
        store.setProfileValue(
          a.id,
          f.field_key,
          null,
          f.required ? "red" : "amber",
          "Your profile has no value for this.",
        );
      } else {
        store.setProfileValue(a.id, f.field_key, value, null, null);
      }
      fields++;
    }
    const resume = await refreshResumeHeader(store, a, header, outDir);
    if (!fields && !resume) continue;
    out.applications.push(a.id);
    out.fields += fields;
    if (resume) out.resumes++;
    store.logEvent(a.id, "contact_refreshed", { fields, resume });
    if (missingRequired && a.status === "approved") {
      store.setStatus(a.id, "ready");
      out.sentBack.push(a.id);
    }
    refreshReadiness(store, a.id);
  }
  return out;
}

async function refreshResumeHeader(
  store: Store,
  a: { id: number; resume_variant_id: number | null },
  header: ResumeDoc["header"],
  outDir: string,
): Promise<boolean> {
  const variant = a.resume_variant_id ? store.getResumeVariant(a.resume_variant_id) : null;
  const saved = variant?.plan as { doc?: ResumeDoc } | null;
  if (!variant || !saved?.doc) return false;
  if (JSON.stringify(saved.doc.header) === JSON.stringify(header)) return false;
  const path = resumePathFor(outDir, a.id, "resume");
  const doc: ResumeDoc = { ...saved.doc, header };
  const pdf = await renderResumePdf(doc);
  // Only rewrite a PDF that exists: a resume that was never rendered stays that way.
  if (existsSync(path)) writeFileSync(path, pdf);
  store.updateResumeVariant(variant.id, { ...saved, doc }, await parseCheckResume(pdf, doc));
  return true;
}

/** One line for the terminal, without any of the values. */
export function describeSync(s: ContactSync): string | null {
  if (!s.applications.length) return null;
  const parts = [`${s.fields} field${s.fields === 1 ? "" : "s"}`];
  if (s.resumes) parts.push(`${s.resumes} resume${s.resumes === 1 ? "" : "s"}`);
  let line = `Contact details updated from profile.yaml on ${s.applications.length} application${s.applications.length === 1 ? "" : "s"} (${parts.join(", ")}).`;
  if (s.sentBack.length)
    line += ` ${s.sentBack.length} approved application${s.sentBack.length === 1 ? " is" : "s are"} back in review: a required contact value is now missing.`;
  return line;
}
