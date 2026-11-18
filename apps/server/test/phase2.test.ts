import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BatchClient, BatchResultLine, DraftOutput } from "@ia/ai";
import { FakeLlm } from "@ia/ai";
import { classifyQuestion } from "@ia/core";
import { makePosting, testProfile } from "@ia/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { collectPrepBatches, submitPrepBatch } from "../src/batch.ts";
import { runScoring } from "../src/pipeline.ts";
import type { PrepDeps } from "../src/prep.ts";
import { runPrep } from "../src/prep.ts";
import { memoryStore, routeFetch } from "./helpers.ts";

const profile = testProfile();
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const draft: DraftOutput = {
  resume: {
    entries: [
      {
        entry_id: "exp.lab",
        bullets: [
          {
            text: "Cut the nightly processing job from 6 hours to 40 minutes",
            fact_ids: ["exp.lab.f2"],
          },
        ],
      },
    ],
    skills_order: ["python"],
    courses: [],
  },
  answers: [],
  cover_letter: null,
  fit_note: { why: "Python.", gaps: "" },
};

class FakeBatch implements BatchClient {
  created: Parameters<BatchClient["create"]>[0][] = [];
  state: "in_progress" | "ended" = "in_progress";
  fail = new Set<string>();
  async create(requests: Parameters<BatchClient["create"]>[0]) {
    this.created.push(requests);
    return { id: `msgbatch_${this.created.length}` };
  }
  async status() {
    return this.state;
  }
  async *results(): AsyncIterable<BatchResultLine> {
    for (const r of this.created.at(-1) ?? []) {
      if (this.fail.has(r.custom_id)) {
        yield { custom_id: r.custom_id, type: "errored", error: "overloaded" };
        continue;
      }
      yield {
        custom_id: r.custom_id,
        type: "succeeded",
        message: {
          content: [{ type: "text", text: JSON.stringify(draft) }],
          stop_reason: "end_turn",
          model: "claude-opus-5-5",
          usage: { input_tokens: 5000, output_tokens: 6000, cache_read_input_tokens: 10000 },
        },
      };
    }
  }
}

async function setup() {
  const out = mkdtempSync(join(tmpdir(), "ia-batch-"));
  dirs.push(out);
  const store = memoryStore();
  // Five Tier B candidates and one Tier A (a target company), at different companies.
  const postings = ["a", "b", "c", "d", "e"].map((n) =>
    makePosting({
      id: `p-${n}`,
      company: `Company ${n}`,
      locations: ["Austin, TX"],
      descriptionText: "Python.",
    }),
  );
  postings.push(makePosting({ id: "p-dream", company: "Dream Corp" }));
  store.savePostings(postings);
  const deps: PrepDeps = {
    store,
    profile: { ...profile, preferences: { ...profile.preferences, locations: [] } },
    fetch: routeFetch({}),
    llm: new FakeLlm({ truth_check: () => ({ verdicts: [] }) }),
    outDir: out,
    now: () => new Date("2026-11-17T12:00:00Z"),
  };
  await runScoring({ ...deps, llm: null });
  return deps;
}

describe("Batch API prep", () => {
  it("sends only Tier B drafting, without fallbacks, with the cached system prefix", async () => {
    const deps = await setup();
    const client = new FakeBatch();
    const tiers = deps.store.rankedCandidates().map((r) => r.score.fit?.tier);
    expect(tiers.filter((t) => t === "B").length).toBe(5);
    const r = await submitPrepBatch(deps, client, { limit: 3 });
    expect(r).toEqual({ batchId: "msgbatch_1", count: 3 });
    const req = client.created[0]![0]!;
    expect(req.custom_id).toMatch(/^app-\d+$/);
    expect(req.params).toMatchObject({
      model: "claude-opus-5-5",
      output_config: { effort: "medium" },
    });
    expect(req.params.system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(req.params).not.toHaveProperty("fallbacks");
    expect(deps.store.listApplications().map((a) => a.status)).toEqual([
      "prepared",
      "prepared",
      "prepared",
    ]);
  });

  it("leaves in-flight applications alone, then finishes them like live prep", async () => {
    const deps = await setup();
    const client = new FakeBatch();
    await submitPrepBatch(deps, client, { limit: 3 });
    const ids = deps.store.listApplications().map((a) => a.id);
    client.fail.add(`app-${ids[2]}`);

    // Live prep must not pick up the three waiting on the batch.
    const live = await runPrep({ ...deps, llm: null }, { tiers: ["B"], limit: 10 });
    expect(live.prepared).toBe(2);

    expect(await collectPrepBatches(deps, client)).toEqual({
      batches: 1,
      pending: 1,
      completed: 0,
      failed: 0,
    });
    client.state = "ended";
    expect(await collectPrepBatches(deps, client)).toEqual({
      batches: 1,
      pending: 0,
      completed: 2,
      failed: 1,
    });
    expect(deps.store.getApplication(ids[0]!)!.status).toBe("ready");
    expect(deps.store.getApplication(ids[2]!)!.status).toBe("prepared");
    expect(deps.store.events(ids[2]!).map((e) => e.type)).toContain("batch_failed");
    expect(deps.store.costSummary()).toEqual([{ purpose: "draft", calls: 2, usd: 0.142 }]);
    // Collected batches are closed; the failed one is now eligible for a live retry.
    expect(await collectPrepBatches(deps, client)).toMatchObject({ batches: 0 });
    expect((await runPrep({ ...deps, llm: null }, { tiers: ["B"], limit: 10 })).prepared).toBe(1);
  });
});

describe("Phase 2 question handling", () => {
  it("fills SmartRecruiters' email confirmation from the profile", () => {
    expect(
      classifyQuestion({ key: "confirmEmail", label: "Confirm your email", type: "text" }),
    ).toEqual({ kind: "known", field: "email" });
  });
});
