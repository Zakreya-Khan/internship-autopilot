// Phase 3: a best-effort adapter for career sites no other adapter knows.
import { byLabel, byNameOrId, labelText, norm } from "./dom.ts";
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
      !el.closest("header, nav, footer, [role=search]"),
  );
}

function labelFor(el: Element, doc: Document): string {
  const id = el.getAttribute("id");
  if (id) {
    const l = doc.querySelector(`label[for="${id.replace(/"/g, '\\"')}"]`);
    if (l) return labelText(l);
  }
  const wrap = el.closest("label");
  if (wrap) return labelText(wrap);
  const aria = el.getAttribute("aria-label");
  if (aria) return norm(aria);
  const legend = el.closest("fieldset")?.querySelector("legend");
  if (legend) return norm(legend.textContent);
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
    if (el instanceof HTMLInputElement && el.type === "radio") {
      if (seenGroups.has(el.name)) continue;
      seenGroups.add(el.name);
      const group = [
        ...root.querySelectorAll<HTMLInputElement>(
          `input[type=radio][name="${el.name.replace(/"/g, '\\"')}"]`,
        ),
      ];
      const key = `ia-${n++}`;
      group.forEach((g) => g.setAttribute("data-ia-key", key));
      const legend = el.closest("fieldset")?.querySelector("legend");
      out.push({
        key,
        label: legend ? norm(legend.textContent) : norm(el.name),
        type: "radio",
        required: el.required,
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
