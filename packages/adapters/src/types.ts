export type AdapterId =
  "greenhouse" | "lever" | "ashby" | "workday" | "smartrecruiters" | "icims" | "generic";

/** One field from the server's fill plan. */
export interface FillField {
  key: string;
  label: string;
  type: string;
  value: string | null;
  options?: string[] | null;
  required: boolean;
  attach?: "resume" | "cover_letter" | null;
}

export interface FillFiles {
  resume?: File;
  cover_letter?: File;
}

export interface FieldResult {
  key: string;
  status: "filled" | "skipped" | "not_found" | "failed";
  /** What the page holds after filling, read back from the control. */
  seen: string | null;
  reason?: string;
}

export interface Adapter {
  id: AdapterId;
  matches(url: URL, doc: Document): boolean;
  /** The application form, or null when this page (or wizard step) has no form yet. */
  formRoot(doc: Document): Element | null;
  locate(root: Element, field: FillField, doc: Document): Element | null;
  /** The final submit button, for highlighting only. */
  locateSubmit(doc: Document): HTMLElement | null;
  isConfirmation(doc: Document, url: URL): boolean;
  /** Multi-step forms: the button to the next step, if this isn't the last one. */
  nextStep?(doc: Document): HTMLElement | null;
  /** A sign-in or create-account screen is showing: the person handles it, never the tool. */
  needsSignIn?(doc: Document): boolean;
  /** How long to wait for the form to appear (sign-in can take minutes). */
  formWaitMs?: number;
}
