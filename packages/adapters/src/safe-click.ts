// The only two places any adapter is allowed to click, and both refuse anything submit-like.
// ESLint bans `.click()` everywhere else in adapter and extension code.

const SUBMIT_WORDS =
  /\b(submit|apply|confirm|send|finish|complete application|review and submit)\b/i;

export class SubmitGuardError extends Error {
  constructor(text: string) {
    super(`Refused to press "${text}": the tool never submits. You press that button yourself.`);
  }
}

function buttonText(el: HTMLElement): string {
  return (
    el.innerText ||
    el.textContent ||
    el.getAttribute("aria-label") ||
    el.getAttribute("value") ||
    ""
  ).trim();
}

/** True for anything that could send an application. */
export function isSubmitLike(el: HTMLElement): boolean {
  const text = buttonText(el);
  if (SUBMIT_WORDS.test(text)) return true;
  if (el.getAttribute("data-automation-id") === "pageFooterSubmitButton") return true;
  const type = (el.getAttribute("type") ?? "").toLowerCase();
  const isNextLike = /\b(next|continue|save and continue)\b/i.test(text);
  return type === "submit" && !isNextLike;
}

function press(el: HTMLElement): void {
  if (isSubmitLike(el)) throw new SubmitGuardError(buttonText(el));
  // eslint-disable-next-line no-restricted-properties -- guarded above: never a submit-like button
  el.click();
}

/**
 * Wizard navigation only (e.g. Workday's "Save and Continue"). The button text must say
 * next/continue, and it must not look like a submit.
 */
export function clickWizardNext(el: HTMLElement): void {
  if (!/\b(next|continue)\b/i.test(buttonText(el))) throw new SubmitGuardError(buttonText(el));
  press(el);
}

/** A choice button inside one field (e.g. Ashby's Yes/No toggles). Its text must equal the answer. */
export function pressChoice(el: HTMLElement, answer: string): void {
  if (buttonText(el).toLowerCase() !== answer.trim().toLowerCase()) {
    throw new Error(`Choice button "${buttonText(el)}" doesn't match "${answer}"`);
  }
  press(el);
}

/** Open a custom dropdown so an option can be chosen. Only elements that declare a listbox popup. */
export function openListbox(el: HTMLElement): void {
  const popup = el.getAttribute("aria-haspopup");
  if (popup !== "listbox" && !(el.getAttribute("role") === "combobox" && popup)) {
    throw new Error("openListbox only opens elements that declare a listbox popup");
  }
  press(el);
}
