// Phase 3: a best-effort adapter for career sites no other adapter knows.
import { byLabel, byNameOrId, FIELD_CONTAINER, labelText, norm } from "./dom.ts";
import { looksConfirmed } from "./engine.ts";
import { isSubmitLike } from "./safe-click.ts";
import type { Adapter } from "./types.ts";

export interface PageFieldInfo {
  key: string;
  label: string;
  type:
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
  required: boolean;
  options?: string[];
}

const SKIP_TYPES = new Set(["hidden", "password", "submit", "button", "reset", "image", "search"]);

function controlsIn(
  root: ParentNode,
): (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[] {
  return [
    ...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      "input, textarea, select",
    ),
  ].filter(
    (el) =>
      !(el instanceof HTMLInputElement && SKIP_TYPES.has(el.type)) &&
      // react-select's hidden "required" proxy duplicates the real combobox beside it.
      !(el.getAttribute("aria-hidden") === "true" && el.getAttribute("tabindex") === "-1") &&
      !el.closest("header, nav, footer, [role=search]"),
  );
}

const esc = (v: string) => v.replace(/(["\\])/g, "\\$1");

/** Text of the element(s) named by aria-labelledby. */
function labelledBy(el: Element, doc: Document): string {
  const ids = el.getAttribute("aria-labelledby");
  if (!ids) return "";
  return norm(
    ids
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent ?? "")
      .join(" "),
  );
}

/**
 * The question a control belongs to, from the field container around it: Lever's
 * `.application-label`, Ashby's question title, a legend, or a label that isn't an option's own.
 * Only used when the container holds one question (one control, or one same-name group).
 */
function questionText(el: Element): string {
  const box = el.closest(FIELD_CONTAINER);
  if (!box) return "";
  const controls = [...box.querySelectorAll("input:not([type=hidden]), textarea, select")];
  const names = new Set(controls.map((c) => c.getAttribute("name") ?? c.id));
  if (names.size > 1) return "";
  const heading = box.querySelector(
    ".application-label, [class*=question-title], [class*=questionTitle], legend, label:not(:has(input, select, textarea))",
  );
  return heading ? labelText(heading) : "";
}

/** A radio or checkbox group's question. Each input's own <label> is an option, never the question. */
function groupLabel(el: HTMLInputElement, doc: Document): string {
  const legend = el.closest("fieldset")?.querySelector("legend");
  if (legend) return norm(legend.textContent);
  const byName = el.name ? doc.querySelector(`label[for="${esc(el.name)}"]`) : null;
  if (byName) return labelText(byName);
  return (
    norm(el.closest("[role=radiogroup], [role=group]")?.getAttribute("aria-label")) ||
    labelledBy(el.closest("[aria-labelledby]") ?? el, doc) ||
    questionText(el) ||
    norm(el.name)
  );
}

function labelFor(el: Element, doc: Document): string {
  const id = el.getAttribute("id");
  if (id) {
    const l = doc.querySelector(`label[for="${esc(id)}"]`);
    if (l) return labelText(l);
  }
  // Ashby's yes/no questions point their label at the field's name, not an id.
  const name = el.getAttribute("name");
  if (name) {
    const l = doc.querySelector(`label[for="${esc(name)}"]`);
    if (l) return labelText(l);
  }
  const aria = el.getAttribute("aria-label");
  if (aria) return norm(aria);
  const by = labelledBy(el, doc);
  if (by) return by;
  const isChoice =
    el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio");
  // A wrapping label is the question, except around a checkbox or radio, where it's the option.
  const wrap = el.closest("label");
  if (wrap && !isChoice) return labelText(wrap);
  const legend = el.closest("fieldset")?.querySelector("legend");
  if (legend) return norm(legend.textContent);
  const q = questionText(el);
  if (q) return q;
  if (wrap) return labelText(wrap);
  return norm(el.getAttribute("placeholder") ?? el.getAttribute("name") ?? "");
}

function genericFormRoot(doc: Document): Element | null {
  const forms = [...doc.querySelectorAll("form")].filter((f) => controlsIn(f).length >= 2);
  forms.sort((a, b) => controlsIn(b).length - controlsIn(a).length);
  if (forms[0]) return forms[0];
  return controlsIn(doc).length >= 2 ? doc.body : null;
}

/**
 * List the form's fields and tag each with data-ia-key so it can be found again. Radio groups
 * become one field. Password fields are never listed.
 */
export function extractPageFields(doc: Document): PageFieldInfo[] {
  const root = genericFormRoot(doc);
  if (!root) return [];
  const out: PageFieldInfo[] = [];
  const seenGroups = new Set<string>();
  let n = 0;
  for (const el of controlsIn(root)) {
    const groupOf = (type: "radio" | "checkbox") =>
      el.name
        ? [
            ...root.querySelectorAll<HTMLInputElement>(
              `input[type=${type}][name="${esc(el.name)}"]`,
            ),
          ]
        : [];
    const isGroup =
      el instanceof HTMLInputElement &&
      (el.type === "radio" || (el.type === "checkbox" && groupOf("checkbox").length > 1));
    if (el instanceof HTMLInputElement && isGroup) {
      if (seenGroups.has(el.name)) continue;
      seenGroups.add(el.name);
      const type = el.type === "radio" ? "radio" : "checkbox";
      const group = groupOf(type);
      const key = `ia-${n++}`;
      group.forEach((g) => g.setAttribute("data-ia-key", key));
      out.push({
        key,
        label: groupLabel(el, doc),
        type: type === "radio" ? "radio" : "multi_select",
        required: group.some((g) => g.required),
        options: group.map((g) => (g.labels?.[0] ? labelText(g.labels[0]) : g.value)),
      });
      continue;
    }
    const key = el.getAttribute("data-ia-key") ?? `ia-${n++}`;
    el.setAttribute("data-ia-key", key);
    const type: PageFieldInfo["type"] =
      el instanceof HTMLSelectElement
        ? el.multiple
          ? "multi_select"
          : "select"
        : el instanceof HTMLTextAreaElement
          ? "textarea"
          : el.type === "file"
            ? "file"
            : el.type === "checkbox"
              ? "checkbox"
              : el.type === "date"
                ? "date"
                : el.type === "number"
                  ? "number"
                  : "text";
    const info: PageFieldInfo = {
      key,
      label: labelFor(el, doc),
      type,
      required: el.required || el.getAttribute("aria-required") === "true",
    };
    if (el instanceof HTMLSelectElement) {
      info.options = [...el.options]
        .filter((o) => o.value !== "")
        .map((o) => (o.textContent ?? "").trim());
    }
    out.push(info);
  }
  return out;
}

export const generic: Adapter = {
  id: "generic",
  matches: () => true,
  formRoot: genericFormRoot,
  locate: (root, field, doc) =>
    root.querySelector(`[data-ia-key="${field.key.replace(/"/g, '\\"')}"]`) ??
    byNameOrId(root, field.key) ??
    byLabel(root, field.label, doc),
  locateSubmit: (doc) => {
    const root = genericFormRoot(doc) ?? doc.body;
    return (
      [...root.querySelectorAll<HTMLElement>("button, input[type=submit]")].find((b) =>
        isSubmitLike(b),
      ) ?? null
    );
  },
  isConfirmation: (doc) => looksConfirmed(doc),
};
