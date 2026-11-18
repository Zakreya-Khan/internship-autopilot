import {
  attachFile,
  chooseInGroup,
  FIELD_CONTAINER,
  isControl,
  norm,
  readValue,
  selectOption,
  setNativeValue,
  visibleText,
} from "./dom.ts";
import { clickWizardNext, openListbox, pressChoice } from "./safe-click.ts";
import type { Adapter, FieldResult, FillField, FillFiles } from "./types.ts";

const CONFIRMATION_TEXT =
  /thank(s| you) for (applying|your application|your interest)|application (has been |was )?(submitted|received)|we('ve| have) received your application|your application is complete/i;

export function looksConfirmed(doc: Document): boolean {
  return CONFIRMATION_TEXT.test(visibleText(doc));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll until `probe` returns something, or give up. */
export async function waitFor<T>(
  probe: () => T | null | undefined,
  timeoutMs: number,
  everyMs = 100,
): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(everyMs);
  }
}

/** Choice buttons (role=button or <button>) in the same field container as a label. */
function choiceButtons(target: Element): HTMLElement[] {
  const container = target.closest(FIELD_CONTAINER) ?? target;
  return [
    ...container.querySelectorAll<HTMLElement>("button[type=button], [role=radio], [role=button]"),
  ];
}

/** A custom dropdown (e.g. Workday's "Select One" button) in a field container. */
function listboxButton(target: Element): HTMLElement | null {
  const container = target.closest(FIELD_CONTAINER) ?? target;
  return container.querySelector<HTMLElement>(
    "[aria-haspopup=listbox], [role=combobox][aria-haspopup]",
  );
}

async function chooseFromListbox(btn: HTMLElement, value: string, doc: Document): Promise<boolean> {
  openListbox(btn);
  const want = norm(value);
  const option = await waitFor(
    () =>
      [...doc.querySelectorAll<HTMLElement>("[role=option]")].find(
        (o) => norm(o.textContent) === want,
      ),
    3000,
  );
  if (!option) return false;
  pressChoice(option, (option.textContent ?? "").trim());
  return true;
}

async function fillOne(
  found: Element,
  field: FillField,
  files: FillFiles,
  doc: Document,
): Promise<FieldResult> {
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
  if (value === null || value === "") {
    return { key, status: "skipped", seen: isControl(target) ? readValue(target, doc) : null };
  }

  if (!isControl(target)) {
    const listbox = listboxButton(target);
    if (listbox) {
      return (await chooseFromListbox(listbox, value, doc))
        ? { key, status: "filled", seen: (listbox.textContent ?? "").trim() || value }
        : { key, status: "failed", seen: null, reason: "no option in the list matches" };
    }
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
export async function fillForm(
  adapter: Adapter,
  doc: Document,
  fields: FillField[],
  files: FillFiles,
): Promise<FieldResult[]> {
  const root = adapter.formRoot(doc);
  if (!root)
    return fields.map((f) => ({
      key: f.key,
      status: "not_found",
      seen: null,
      reason: "no form on this page",
    }));
  const out: FieldResult[] = [];
  for (const field of fields) {
    if (field.value === null && !field.attach) {
      out.push({ key: field.key, status: "skipped", seen: null });
      continue;
    }
    const target = adapter.locate(root, field, doc);
    if (!target) {
      out.push({
        key: field.key,
        status: "not_found",
        seen: null,
        reason: "no matching field on the page",
      });
      continue;
    }
    try {
      out.push(await fillOne(target, field, files, doc));
    } catch (e) {
      out.push({ key: field.key, status: "failed", seen: null, reason: String(e) });
    }
  }
  return out;
}

const STATUS_RANK: Record<FieldResult["status"], number> = {
  filled: 3,
  failed: 2,
  skipped: 1,
  not_found: 0,
};

/** Keep the best outcome per field across wizard steps. */
export function mergeResults(a: FieldResult[], b: FieldResult[]): FieldResult[] {
  const by = new Map(a.map((r) => [r.key, r]));
  for (const r of b) {
    const prev = by.get(r.key);
    if (!prev || STATUS_RANK[r.status] > STATUS_RANK[prev.status]) by.set(r.key, r);
  }
  return [...by.values()];
}

export interface WizardOutcome {
  results: FieldResult[];
  steps: number;
  /** "review": stopped on the last step with Submit showing. "blocked": the page reported a problem. */
  stoppedAt: "review" | "blocked" | "no_next" | "step_limit";
  message: string | null;
}

function pageErrors(doc: Document): string[] {
  return [
    ...doc.querySelectorAll("[data-automation-id=errorMessage], [role=alert], .error-message"),
  ]
    .map((e) => (e.textContent ?? "").trim())
    .filter(Boolean);
}

/**
 * Multi-step forms (Workday): fill this step, press Next only if the page shows no errors,
 * repeat, and stop on the review step with the Submit button outlined. The Submit is yours.
 */
export async function runWizard(
  adapter: Adapter,
  doc: Document,
  fields: FillField[],
  files: FillFiles,
  opts: { maxSteps?: number; stepTimeoutMs?: number; settleMs?: number } = {},
): Promise<WizardOutcome> {
  let results: FieldResult[] = [];
  for (let step = 1; step <= (opts.maxSteps ?? 12); step++) {
    results = mergeResults(results, await fillForm(adapter, doc, fields, files));
    await sleep(opts.settleMs ?? 400);
    const errors = pageErrors(doc);
    if (errors.length)
      return {
        results,
        steps: step,
        stoppedAt: "blocked",
        message: `This step needs you: ${errors.join("; ")}`,
      };
    const next = adapter.nextStep?.(doc) ?? null;
    if (!next) {
      highlightSubmit(adapter, doc);
      return {
        results,
        steps: step,
        stoppedAt: adapter.locateSubmit(doc) ? "review" : "no_next",
        message: null,
      };
    }
    const marker =
      doc.querySelector("[data-automation-id=progressBarActiveStep], h2, h3")?.textContent ?? "";
    clickWizardNext(next);
    const moved = await waitFor(() => {
      const now =
        doc.querySelector("[data-automation-id=progressBarActiveStep], h2, h3")?.textContent ?? "";
      return now !== marker || pageErrors(doc).length > 0 ? true : null;
    }, opts.stepTimeoutMs ?? 20_000);
    if (!moved)
      return { results, steps: step, stoppedAt: "blocked", message: "The next step didn't load." };
  }
  return {
    results,
    steps: opts.maxSteps ?? 12,
    stoppedAt: "step_limit",
    message: "Stopped after too many steps.",
  };
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
