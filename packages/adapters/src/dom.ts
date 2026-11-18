// DOM helpers shared by every adapter. They run in a content script and in Playwright tests.

export function norm(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/\*/g, "")
    .replace(/\((required|optional)\)/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

export function isControl(el: Element | null): el is Control {
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");
}

/** The text a label element shows, without nested option or input text. */
export function labelText(label: Element): string {
  const clone = label.cloneNode(true) as Element;
  clone.querySelectorAll("select, option, input, textarea, button").forEach((n) => n.remove());
  return norm(clone.textContent);
}

/** Find a control by its name or id. */
export function byNameOrId(root: ParentNode, key: string): Control | null {
  const esc = (s: string) => s.replace(/(["\\])/g, "\\$1");
  for (const sel of [`[name="${esc(key)}"]`, `[id="${esc(key)}"]`]) {
    const el = root.querySelector(sel);
    if (isControl(el)) return el;
  }
  return null;
}

export const FIELD_CONTAINER =
  "fieldset, [role=group], .field, .application-question, [class*=field-entry], [class*=question], [data-automation-id*=formField]";

/** Find a control by its visible label: <label for>, a wrapping <label>, aria-label or aria-labelledby. */
export function byLabel(root: ParentNode, label: string, doc: Document): Control | null {
  const want = norm(label);
  if (!want) return null;
  const labels = [...root.querySelectorAll("label, legend")];
  const match =
    labels.find((l) => labelText(l) === want) ?? labels.find((l) => labelText(l).startsWith(want));
  if (match) {
    const forId = match.getAttribute("for");
    if (forId) {
      const el = doc.getElementById(forId);
      if (isControl(el)) return el;
    }
    const inner = match.querySelector("input:not([type=hidden]), textarea, select");
    if (isControl(inner) && labelText(match) === want) return inner;
    const sib = match.nextElementSibling;
    if (isControl(sib)) return sib;
    // A legend or label beside its control: use the field container, but only when it holds
    // a single control (or one radio/checkbox group), so a loose label never grabs a neighbour.
    const container = match.closest(FIELD_CONTAINER);
    if (container) {
      const controls = [
        ...container.querySelectorAll<Control>("input:not([type=hidden]), textarea, select"),
      ];
      const names = new Set(controls.map((c) => c.getAttribute("name") ?? c.id));
      if (controls.length === 1 || (controls.length > 1 && names.size === 1)) return controls[0]!;
    }
  }
  for (const el of root.querySelectorAll("input, textarea, select")) {
    if (norm(el.getAttribute("aria-label")) === want) return el as Control;
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const text = by
        .split(/\s+/)
        .map((id) => doc.getElementById(id)?.textContent ?? "")
        .join(" ");
      if (norm(text) === want) return el as Control;
    }
  }
  return null;
}

/**
 * Set a value the way typing would. React and similar libraries ignore a plain `el.value = x`,
 * so this uses the prototype's native setter and then fires input and change events.
 */
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
}

export function selectOption(el: HTMLSelectElement, value: string): boolean {
  const want = norm(value);
  const opt =
    [...el.options].find((o) => norm(o.textContent) === want) ??
    [...el.options].find((o) => norm(o.value) === want);
  if (!opt) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  if (setter) setter.call(el, opt.value);
  else el.value = opt.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

/** Tick the radio (or checkboxes) in a group whose label matches. Checks only; never unticks yours. */
export function chooseInGroup(el: HTMLInputElement, values: string[], doc: Document): boolean {
  const group = el.name
    ? [...doc.querySelectorAll<HTMLInputElement>(`input[name="${el.name.replace(/"/g, '\\"')}"]`)]
    : [el];
  const wanted = values.map(norm);
  let any = false;
  for (const input of group) {
    const label = input.labels?.[0] ? labelText(input.labels[0]) : norm(input.value);
    if (wanted.includes(label) || wanted.includes(norm(input.value))) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set;
      if (setter) setter.call(input, true);
      else input.checked = true;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      any = true;
    }
  }
  return any;
}

/** Attach a file the way a drag-and-drop would. */
export function attachFile(el: HTMLInputElement, file: File): boolean {
  try {
    const dt = new DataTransfer();
    dt.items.add(file);
    el.files = dt.files;
  } catch {
    return false;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return (el.files?.length ?? 0) > 0;
}

export function readValue(el: Control, doc: Document): string | null {
  if (el instanceof HTMLSelectElement) {
    const o = el.selectedOptions[0];
    return o && o.value !== "" ? (o.textContent ?? "").trim() : null;
  }
  if (el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox")) {
    const group = el.name
      ? [...doc.querySelectorAll<HTMLInputElement>(`input[name="${el.name.replace(/"/g, '\\"')}"]`)]
      : [el];
    const on = group
      .filter((i) => i.checked)
      .map((i) => (i.labels?.[0] ? (i.labels[0].textContent ?? "").trim() : i.value));
    return on.length ? on.join(", ") : null;
  }
  if (el instanceof HTMLInputElement && el.type === "file") return el.files?.[0]?.name ?? null;
  return el.value === "" ? null : el.value;
}

export function base64ToFile(base64: string, name: string, type = "application/pdf"): File {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type });
}

export function visibleText(doc: Document): string {
  return (doc.body?.innerText || doc.body?.textContent || "").replace(/\s+/g, " ");
}
