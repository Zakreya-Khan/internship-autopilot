import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ApplicationStatus } from "@ia/core";
import {
  classifyEmail,
  isSubmittedOrLater,
  matchEmail,
  parseEmail,
  splitMbox,
  statusFromEmail,
} from "@ia/core";
import type { Store } from "./db.ts";

export interface SyncReport {
  read: number;
  matched: number;
  updated: {
    applicationId: number;
    company: string;
    from: ApplicationStatus;
    to: ApplicationStatus;
    subject: string;
  }[];
}

function readMessages(path: string): string[] {
  if (statSync(path).isDirectory()) {
    return readdirSync(path)
      .filter((f) => f.endsWith(".eml"))
      .map((f) => readFileSync(join(path, f), "utf8"));
  }
  return splitMbox(readFileSync(path, "utf8"));
}

/**
 * Update statuses from an email export (Gmail Takeout .mbox, or a folder of .eml files).
 * Fully local: no mailbox sign-in, and no email text is sent anywhere. Only forward moves the
 * status machine allows are applied, oldest email first, and each is logged with its subject.
 */
export function syncEmails(
  store: Store,
  path: string,
  opts: { dryRun?: boolean } = {},
): SyncReport {
  const emails = readMessages(path)
    .map(parseEmail)
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  const report: SyncReport = { read: emails.length, matched: 0, updated: [] };
  for (const e of emails) {
    const tracked = store
      .listApplications()
      .filter((a) => isSubmittedOrLater(a.status) || a.status === "no_response")
      .map((a) => ({
        id: a.id,
        company: store.getPosting(a.posting_id)?.company ?? "",
        status: a.status,
        submittedAt: a.submitted_at,
      }));
    const app = matchEmail(e, tracked);
    if (!app) continue;
    report.matched++;
    const to = statusFromEmail(app.status, classifyEmail(e));
    if (!to) continue;
    report.updated.push({
      applicationId: app.id,
      company: app.company,
      from: app.status,
      to,
      subject: e.subject,
    });
    if (!opts.dryRun) {
      store.setStatus(app.id, to);
      store.logEvent(app.id, "email", { subject: e.subject, date: e.date, to });
    }
  }
  return report;
}
