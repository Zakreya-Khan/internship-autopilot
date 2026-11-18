// Phase 2 adapters: Workday (multi-step, per-company accounts), SmartRecruiters, iCIMS.
import { byLabel, byNameOrId, FIELD_CONTAINER, norm } from "./dom.ts";
import { looksConfirmed } from "./engine.ts";
import type { Adapter, FillField } from "./types.ts";

function buttonWithText(doc: ParentNode, re: RegExp): HTMLElement | null {
  return (
    [...doc.querySelectorAll<HTMLElement>("button, input[type=submit], [role=button]")].find((b) =>
      re.test((b.textContent || b.getAttribute("value") || "").trim()),
    ) ?? null
  );
}

function labelledContainer(root: ParentNode, label: string): Element | null {
  const want = norm(label);
  const hit = [...root.querySelectorAll("label, legend, [data-automation-id*=formLabel]")].find(
    (l) => norm(l.textContent) === want,
  );
  return hit?.closest(FIELD_CONTAINER) ?? null;
}

/** Workday's stable data-automation-id values for the standard fields. */
const WORKDAY_IDS: Record<string, string[]> = {
  first_name: ["legalNameSection_firstName"],
  last_name: ["legalNameSection_lastName"],
  email: ["email"],
  phone: ["phone-number", "phoneNumber"],
  city: ["addressSection_city"],
  location: ["addressSection_city"],
  resume: ["file-upload-input-ref"],
  linkedin: ["linkedinQuestion"],
};

function byAutomationId(root: ParentNode, ids: string[]): Element | null {
  for (const id of ids) {
    const el = root.querySelector(`[data-automation-id="${id}"]`);
    if (el) return el;
  }
  return null;
}

export const workday: Adapter = {
  id: "workday",
  matches: (url) => /\.myworkday(jobs|site)\.com$/.test(url.hostname),
  formWaitMs: 10 * 60_000, // time for you to sign in or create the account
  needsSignIn: (doc) =>
    !!doc.querySelector(
      "input[type=password], [data-automation-id=signInContent], [data-automation-id=createAccountLink]",
    ),
  formRoot: (doc) => {
    if (workday.needsSignIn!(doc)) return null;
    return doc.querySelector(
      "[data-automation-id=applyFlowPage], [data-automation-id*=applyFlow], main form, [role=main]",
    );
  },
  locate: (root, field: FillField, doc) =>
    byAutomationId(root, WORKDAY_IDS[field.key] ?? []) ??
    byLabel(root, field.label, doc) ??
    labelledContainer(root, field.label),
  locateSubmit: (doc) =>
    doc.querySelector<HTMLElement>("[data-automation-id=pageFooterSubmitButton]") ??
    (doc.querySelector("[data-automation-id=reviewJobApplicationPage]")
      ? buttonWithText(doc, /^submit$/i)
      : null),
  nextStep: (doc) => {
    if (doc.querySelector("[data-automation-id=pageFooterSubmitButton]")) return null;
    const btn =
      doc.querySelector<HTMLElement>(
        "[data-automation-id=pageFooterNextButton], [data-automation-id=bottom-navigation-next-button]",
      ) ?? buttonWithText(doc, /^(save and continue|next|continue)$/i);
    return btn && /\b(next|continue)\b/i.test(btn.textContent ?? "") ? btn : null;
  },
  isConfirmation: (doc) =>
    looksConfirmed(doc) || /application submitted/i.test(doc.body?.textContent ?? ""),
};

const SR_KEYS: Record<string, string[]> = {
  first_name: ["firstName", "first-name-input"],
  last_name: ["lastName", "last-name-input"],
  email: ["email", "email-input"],
  phone: ["phoneNumber", "phone-number-input"],
  city: ["location", "location-input"],
  linkedin: ["linkedin", "linkedin-input"],
  resume: ["resume", "file-upload"],
};

export const smartrecruiters: Adapter = {
  id: "smartrecruiters",
  matches: (url) => /(^|\.)smartrecruiters\.com$/.test(url.hostname),
  formRoot: (doc) => doc.querySelector("oc-oneclick-form, form, [role=main]"),
  locate: (root, field, doc) => {
    for (const k of SR_KEYS[field.key] ?? [field.key]) {
      const el = byNameOrId(root, k) ?? root.querySelector(`[data-test="${k}"]`);
      if (el) return el;
    }
    return byLabel(root, field.label, doc) ?? labelledContainer(root, field.label);
  },
  locateSubmit: (doc) => buttonWithText(doc, /^(submit|send|apply)( application)?$/i),
  isConfirmation: (doc) => looksConfirmed(doc),
};

export const icims: Adapter = {
  id: "icims",
  matches: (url) => /\.icims\.com$/.test(url.hostname),
  formWaitMs: 5 * 60_000,
  needsSignIn: (doc) => !!doc.querySelector("input[type=password], #login, form[name=loginForm]"),
  formRoot: (doc) =>
    icims.needsSignIn!(doc) ? null : doc.querySelector("form#questionForm, form.iCIMS_Forms, form"),
  locate: (root, field, doc) =>
    byNameOrId(root, field.key) ??
    byLabel(root, field.label, doc) ??
    labelledContainer(root, field.label),
  locateSubmit: (doc) => buttonWithText(doc, /^(submit|submit application|finish)$/i),
  nextStep: (doc) => buttonWithText(doc, /^(next|continue|save (&|and) continue)$/i),
  isConfirmation: (doc) => looksConfirmed(doc),
};
