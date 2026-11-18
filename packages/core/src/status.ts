export const STATUSES = [
  "prepared",
  "needs_input",
  "ready",
  "approved",
  "filled",
  "submitted",
  "online_assessment",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
  "no_response",
  "skipped",
  "parked",
] as const;
export type ApplicationStatus = (typeof STATUSES)[number];

const PRE_SUBMIT: ApplicationStatus[] = ["prepared", "needs_input", "ready", "approved", "filled"];
const OUTCOMES: ApplicationStatus[] = [
  "online_assessment",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
  "no_response",
];

const TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  prepared: ["needs_input", "ready", "skipped", "parked"],
  needs_input: ["ready", "skipped", "parked"],
  ready: ["approved", "needs_input", "skipped", "parked"],
  approved: ["filled", "ready", "skipped", "parked"],
  // "filled" means the extension filled the page. Only the confirmation page or the user moves it on.
  filled: ["submitted", "approved", "skipped", "parked"],
  submitted: OUTCOMES,
  online_assessment: ["interview", "rejected", "withdrawn", "no_response", "offer"],
  interview: ["interview", "offer", "rejected", "withdrawn", "no_response"],
  offer: ["withdrawn"],
  rejected: [],
  withdrawn: [],
  no_response: ["online_assessment", "interview", "offer", "rejected", "withdrawn"],
  skipped: ["prepared", "parked"],
  parked: ["prepared", "skipped"],
};

export function canTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ApplicationStatus, to: ApplicationStatus): void {
  if (!canTransition(from, to)) throw new Error(`Status can't move from ${from} to ${to}`);
}

export function isPreSubmit(s: ApplicationStatus): boolean {
  return PRE_SUBMIT.includes(s);
}

export function isSubmittedOrLater(s: ApplicationStatus): boolean {
  return s === "submitted" || OUTCOMES.includes(s) || s === "offer";
}

/** Days after submission with no news before "no_response" is suggested. */
export const NO_RESPONSE_DAYS = 30;
