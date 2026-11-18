import type { BatchClient } from "@ia/ai";
import {
  batchRequest,
  DraftSchema,
  draftLlmRequest,
  fromDraftOutput,
  parseBatchLine,
} from "@ia/ai";
import type { PrepDeps } from "./prep.ts";
import { completePrep, draftRequest, prepInputs, selectForPrep } from "./prep.ts";

const customId = (applicationId: number) => `app-${applicationId}`;

/**
 * Submit Tier B drafting as one Message Batch (half price, results within 24 h).
 * Applications are created now, in "prepared", and finished by `collectPrepBatches`.
 */
export async function submitPrepBatch(
  deps: PrepDeps,
  client: BatchClient,
  opts: { limit?: number } = {},
): Promise<{ batchId: string | null; count: number }> {
  const { store } = deps;
  const inFlight = new Set(store.openBatches().flatMap((b) => b.application_ids));
  const picks = selectForPrep(deps, { limit: opts.limit ?? 100, tiers: ["B"] }).filter((s) => {
    const existing = store.applicationForPosting(s.posting.id);
    return !existing || !inFlight.has(existing.id);
  });
  if (picks.length === 0) return { batchId: null, count: 0 };
  const inputs = picks.map((s) => prepInputs(deps, s.posting, s.tier));
  const { id } = await client.create(
    inputs.map((i) => batchRequest(customId(i.app.id), draftLlmRequest(draftRequest(deps, i)))),
  );
  store.saveBatch(
    id,
    "draft",
    inputs.map((i) => i.app.id),
  );
  for (const i of inputs) store.logEvent(i.app.id, "batch_submitted", { batchId: id });
  return { batchId: id, count: inputs.length };
}

export interface CollectReport {
  batches: number;
  pending: number;
  completed: number;
  failed: number;
}

/** Finish every ended batch: truth-check, render and plan each draft exactly as live prep does. */
export async function collectPrepBatches(
  deps: PrepDeps,
  client: BatchClient,
): Promise<CollectReport> {
  const { store } = deps;
  const report: CollectReport = { batches: 0, pending: 0, completed: 0, failed: 0 };
  for (const b of store.openBatches()) {
    report.batches++;
    if ((await client.status(b.id)) !== "ended") {
      report.pending++;
      continue;
    }
    for await (const line of client.results(b.id)) {
      const appId = Number(line.custom_id.replace(/^app-/, ""));
      const app = store.getApplication(appId);
      const posting = app ? store.getPosting(app.posting_id) : null;
      if (!app || !posting || app.status !== "prepared") continue;
      const parsed = parseBatchLine(DraftSchema, line);
      if (!parsed.ok) {
        // Left in "prepared": the next prep run retries it live.
        store.logEvent(appId, "batch_failed", { error: parsed.error });
        report.failed++;
        continue;
      }
      store.logLlmCall("draft", parsed.model, parsed.usage, true);
      const inputs = prepInputs(deps, posting, app.tier);
      try {
        const draft = fromDraftOutput(parsed.data, {
          openQuestions: inputs.openToDraft,
          coverLetter: inputs.coverLetter,
        });
        await completePrep(deps, inputs, draft);
        report.completed++;
      } catch (e) {
        store.logEvent(appId, "batch_failed", { error: String(e) });
        report.failed++;
      }
    }
    store.markBatchCollected(b.id);
  }
  return report;
}
