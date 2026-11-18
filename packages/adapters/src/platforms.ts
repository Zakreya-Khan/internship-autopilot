import { byLabel, byNameOrId, FIELD_CONTAINER, norm, visibleText } from "./dom.ts";
import { looksConfirmed } from "./engine.ts";
import type { Adapter, FillField } from "./types.ts";

function buttonWithText(doc: ParentNode, re: RegExp): HTMLElement | null {
  const candidates = [
    ...doc.querySelectorAll<HTMLElement>("button, input[type=submit], [role=button]"),
  ];
  return (
    candidates.find((b) => re.test((b.textContent || b.getAttribute("value") || "").trim())) ?? null
  );
}

/** Field lookup shared by the single-page ATSs: name/id first, then the visible label. */
function locateStandard(
  root: Element,
  field: FillField,
  doc: Document,
  keyAliases: (key: string) => string[] = (k) => [k],
): Element | null {
  for (const k of keyAliases(field.key)) {
    const el = byNameOrId(root, k);
    if (el) return el;
  }
  return byLabel(root, field.label, doc) ?? labelledGroup(root, field.label);
}

/** A labelled container with no form control inside (button-based choices). */
function labelledGroup(root: Element, label: string): Element | null {
  const want = norm(label);
  const all = [
    ...root.querySelectorAll(
      "label, legend, .field-label, .application-label, [role=group] > span",
    ),
  ];
  const hit = all.find((l) => norm(l.textContent) === want);
  return hit?.closest(FIELD_CONTAINER) ?? null;
}

export const greenhouse: Adapter = {
  id: "greenhouse",
  matches: (url, doc) =>
    /(^|\.)greenhouse\.io$/.test(url.hostname) ||
    !!doc.querySelector("#application_form, form#application-form, #grnhse_app"),
  formRoot: (doc) =>
    doc.querySelector(
      "#application_form, form#application-form, #application-form, form[action*='greenhouse']",
    ),
  locate: (root, field, doc) =>
    locateStandard(root, field, doc, (k) => {
      const bare = k.replace(/^(eeo|demographic):/, "");
      return [
        bare,
        `job_application[${bare}]`,
        `job_application[answers_attributes][${bare}][text_value]`,
      ];
    }),
  locateSubmit: (doc) =>
    doc.querySelector<HTMLElement>("#submit_app, button[type=submit]") ??
    buttonWithText(doc, /submit application/i),
  isConfirmation: (doc, url) => /\/confirmation\b/.test(url.pathname) || looksConfirmed(doc),
};

export const lever: Adapter = {
  id: "lever",
  matches: (url) => /(^|\.)lever\.co$/.test(url.hostname),
  formRoot: (doc) =>
    doc.querySelector("form#application-form, form.application-form, .application-page form, form"),
  locate: (root, field, doc) => locateStandard(root, field, doc),
  locateSubmit: (doc) =>
    doc.querySelector<HTMLElement>("#btn-submit, button[data-qa='btn-submit']") ??
    buttonWithText(doc, /submit application/i),
  isConfirmation: (doc, url) => /\/thanks\b/.test(url.pathname) || looksConfirmed(doc),
};

export const ashby: Adapter = {
  id: "ashby",
  matches: (url) => url.hostname === "jobs.ashbyhq.com",
  formRoot: (doc) =>
    doc.querySelector("form.ashby-application-form, [class*='application-form'], form") ??
    (visibleText(doc).toLowerCase().includes("submit application") ? doc.body : null),
  locate: (root, field, doc) => locateStandard(root, field, doc),
  locateSubmit: (doc) => buttonWithText(doc, /^submit application$/i),
  isConfirmation: (doc) => looksConfirmed(doc),
};
