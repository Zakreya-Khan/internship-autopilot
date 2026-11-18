import {
  attachFile,
  chooseInGroup,
  FIELD_CONTAINER,
  isControl,
  readValue,
  selectOption,
  setNativeValue,
  visibleText,
} from "./dom.ts";
import { pressChoice } from "./safe-click.ts";
import type { Adapter, FieldResult, FillField, FillFiles } from "./types.ts";

const CONFIRMATION_TEXT =
  /thank(s| you) for (applying|your application|your interest)|application (has been |was )?(submitted|received)|we('ve| have) received your application|your application is complete/i;

export function looksConfirmed(doc: Document): boolean {
  return CONFIRMATION_TEXT.test(visibleText(doc));
}

/** Choice buttons (role=button or <button>) in the same field container as a label. */
function choiceButtons(target: Element): HTMLElement[] {
  const container = target.closest(FIELD_CONTAINER) ?? target;
  return [
    ...container.querySelectorAll<HTMLElement>("button[type=button], [role=radio], [role=button]"),
  ];
}

function fillOne(found: Element, field: FillField, files: FillFiles, doc: Document): FieldResult {
  const key = field.key;
  // A field container: use the control inside it, if it has one.
  const target = isControl(found)
    ? found
    : (found.querySelector("input:not([type=hidden]), select, textarea") ?? found);
  if (field.attach) {
    const file = files[field.attach];
    if (!file) return { key, status: "skipped", seen: null, reason: `no ${field.attach} file` };
    if (!(target instanceof HTMLInputElement) || target.type !== "file") {
      return { key, status: "failed", seen: null, reason: "expected a file input" };
    }
    return attachFile(target, file)
      ? { key, status: "filled", seen: readValue(target, doc) }
      : { key, status: "failed", seen: null, reason: "the page refused the file" };
  }
  const value = field.value;
  if (value === null || value === "")
    return { key, status: "skipped", seen: isControl(target) ? readValue(target, doc) : null };

  if (!isControl(target)) {
    // A field built from buttons (e.g. Yes/No toggles): press the one whose text is the answer.
    const btn = choiceButtons(target).find(
      (b) => (b.textContent ?? "").trim().toLowerCase() === value.toLowerCase(),
    );
    if (!btn) return { key, status: "failed", seen: null, reason: "no choice button matches" };
    pressChoice(btn, value);
    return { key, status: "filled", seen: value };
  }
  if (target instanceof HTMLInputElement && target.type === "password") {
    return { key, status: "skipped", seen: null, reason: "password fields are never filled" };
  }
  let ok = true;
  if (target instanceof HTMLSelectElement) ok = selectOption(target, value);
  else if (
    target instanceof HTMLInputElement &&
    (target.type === "radio" || target.type === "checkbox")
  ) {
    ok = chooseInGroup(target, value.split(/\s*,\s*/), doc);
  } else setNativeValue(target, value);
  return ok
    ? { key, status: "filled", seen: readValue(target, doc) }
    : {
        key,
        status: "failed",
        seen: readValue(target, doc),
        reason: "no option matches the planned value",
      };
}

/**
 * Fill every field the plan has a value or a file for. Fields left empty in the plan are
 * not touched. Nothing here submits, and nothing here can.
 */
export function fillForm(
  adapter: Adapter,
  doc: Document,
  fields: FillField[],
  files: FillFiles,
): FieldResult[] {
  const root = adapter.formRoot(doc);
  if (!root)
    return fields.map((f) => ({
      key: f.key,
      status: "not_found",
      seen: null,
      reason: "no form on this page",
    }));
  return fields.map((field) => {
    if (field.value === null && !field.attach)
      return { key: field.key, status: "skipped", seen: null };
    const target = adapter.locate(root, field, doc);
    if (!target)
      return {
        key: field.key,
        status: "not_found",
        seen: null,
        reason: "no matching field on the page",
      };
    try {
      return fillOne(target, field, files, doc);
    } catch (e) {
      return { key: field.key, status: "failed", seen: null, reason: String(e) };
    }
  });
}

/** Scroll to the submit button and outline it. The click is yours. */
export function highlightSubmit(adapter: Adapter, doc: Document): HTMLElement | null {
  const btn = adapter.locateSubmit(doc);
  if (!btn) return null;
  btn.style.outline = "4px solid #f5a623";
  btn.style.outlineOffset = "4px";
  btn.setAttribute("data-ia-highlight", "submit");
  btn.scrollIntoView?.({ block: "center", behavior: "smooth" });
  return btn;
}

export function seenMap(results: FieldResult[]): Record<string, string | null> {
  return Object.fromEntries(
    results.filter((r) => r.status !== "not_found").map((r) => [r.key, r.seen]),
  );
}
