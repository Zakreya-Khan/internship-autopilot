import type { ApplicationStatus } from "./status.ts";
import { canTransition } from "./status.ts";
import { normalizeCompany } from "./text.ts";

export interface ParsedEmail {
  from: string;
  subject: string;
  date: string | null;
  body: string;
}

function decodeQuotedPrintable(s: string): string {
  return s
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

function decodeHeader(v: string): string {
  // =?utf-8?Q?...?= and =?utf-8?B?...?= encoded words
  return v.replace(
    /=\?([^?]+)\?([QB])\?([^?]*)\?=/gi,
    (_, _cs: string, enc: string, text: string) =>
      enc.toUpperCase() === "B"
        ? Buffer.from(text, "base64").toString("utf8")
        : decodeQuotedPrintable(text.replace(/_/g, " ")),
  );
}

/** One RFC 822 message: headers, and the first text/plain part (or stripped HTML). */
export function parseEmail(raw: string): ParsedEmail {
  const sep = raw.search(/\r?\n\r?\n/);
  const head = sep >= 0 ? raw.slice(0, sep) : raw;
  let body = sep >= 0 ? raw.slice(sep).trim() : "";
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  const type = headers.get("content-type") ?? "";
  const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
  if (boundary) {
    const parts = body.split(`--${boundary}`);
    const plain =
      parts.find((p) => /content-type:\s*text\/plain/i.test(p)) ??
      parts.find((p) => /content-type:\s*text\/html/i.test(p));
    if (plain) {
      const s = plain.search(/\r?\n\r?\n/);
      const partHead = plain.slice(0, s);
      body = plain.slice(s).trim();
      if (/quoted-printable/i.test(partHead)) body = decodeQuotedPrintable(body);
      if (/base64/i.test(partHead))
        body = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
    }
  } else if (/quoted-printable/i.test(headers.get("content-transfer-encoding") ?? "")) {
    body = decodeQuotedPrintable(body);
  }
  body = body
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    from: decodeHeader(headers.get("from") ?? ""),
    subject: decodeHeader(headers.get("subject") ?? ""),
    date: headers.get("date") ? new Date(headers.get("date")!).toISOString() : null,
    body,
  };
}

/** Split an .mbox file into raw messages. */
export function splitMbox(text: string): string[] {
  return text
    .split(/^From .*$/m)
    .map((m) => m.replace(/^\r?\n/, "").replace(/^>(>*From )/gm, "$1"))
    .filter((m) => m.trim().length > 0);
}

export type EmailOutcome =
  "received" | "online_assessment" | "interview" | "rejected" | "offer" | null;

const RULES: [EmailOutcome, RegExp][] = [
  [
    "offer",
    /\b(offer letter|pleased to (extend|offer)|we('d| would) like to offer you|congratulations[^.]{0,60}offer)\b/i,
  ],
  [
    "rejected",
    /\b(not (be )?mov(e|ing) forward|unfortunately|other candidates|not (been )?selected|regret to inform|decided not to proceed|will not be proceeding|no longer under consideration|position has been filled)\b/i,
  ],
  [
    "interview",
    /\b(schedule (an|your|a) (interview|call|chat)|invite you to (an )?interview|interview (invitation|request)|next round|phone screen|meet with (our|the) team)\b/i,
  ],
  [
    "online_assessment",
    /\b(online assessment|coding (challenge|assessment|test)|hackerrank|codesignal|codility|hirevue|take-home|assessment invitation)\b/i,
  ],
  [
    "received",
    /\b(thank you for (applying|your application)|we('ve| have) received your application|application (was |has been )?received)\b/i,
  ],
];

/** Rule-based, deliberately: email stays on this machine and is never sent to a model. */
export function classifyEmail(e: Pick<ParsedEmail, "subject" | "body">): EmailOutcome {
  const text = `${e.subject}\n${e.body}`.slice(0, 5000);
  for (const [outcome, re] of RULES) if (re.test(text)) return outcome;
  return null;
}

export interface TrackedApplication {
  id: number;
  company: string;
  status: ApplicationStatus;
  submittedAt: string | null;
}

/** Which tracked application an email is about: the company named in the sender or subject. */
export function matchEmail(e: ParsedEmail, apps: TrackedApplication[]): TrackedApplication | null {
  const hay = normalizeCompany(`${e.from} ${e.subject}`).replace(/\s+/g, " ");
  const domain = /@([a-z0-9.-]+)/i.exec(e.from)?.[1]?.toLowerCase() ?? "";
  const candidates = apps.filter((a) => {
    const c = normalizeCompany(a.company);
    if (!c) return false;
    return (
      ` ${hay} `.includes(` ${c} `) ||
      domain.replace(/[^a-z0-9]/g, "").includes(c.replace(/\s+/g, ""))
    );
  });
  if (candidates.length === 0) return null;
  // The most recently submitted one at that company.
  return [...candidates].sort((a, b) =>
    (b.submittedAt ?? "").localeCompare(a.submittedAt ?? ""),
  )[0]!;
}

/** The status an email moves an application to, or null. Only forward moves the state machine allows. */
export function statusFromEmail(
  current: ApplicationStatus,
  outcome: EmailOutcome,
): ApplicationStatus | null {
  if (!outcome || outcome === "received") return null;
  return canTransition(current, outcome) ? outcome : null;
}
