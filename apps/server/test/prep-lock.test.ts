// One prep run at a time: two at once used to draft the same unfinished application twice.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLlm, UsageLimitError } from "@ia/ai";
import { makePosting, testProfile } from "@ia/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { runScoring } from "../src/pipeline.ts";
import { runPrep } from "../src/prep.ts";
import { memoryStore, routeFetch } from "./helpers.ts";

const profile = testProfile();
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup() {
  const out = mkdtempSync(join(tmpdir(), "ia-out-"));
  dirs.push(out);
  const store = memoryStore();
  const d = { store, profile, fetch: routeFetch({}), llm: null, outDir: out, log: () => {} };
  store.savePostings([makePosting({ id: "p1" })]);
  await runScoring(d);
  return d;
}

/** A process id that isn't running. */
const DEAD_PID = 2 ** 22 + 12345;

describe("prep lock", () => {
  it("does nothing while another live run holds the lock, and runs once it's released", async () => {
    const d = await setup();
    expect(d.store.tryLock("prep")).toBeNull();
    const busy = await runPrep(d);
    expect(busy).toMatchObject({ prepared: 0, busy: true });
    expect(busy.stopped).toMatch(new RegExp(`process ${process.pid}`));
    expect(d.store.listApplications()).toHaveLength(0);

    d.store.unlock("prep");
    expect(await runPrep(d)).toMatchObject({ prepared: 1, busy: false });
    // Released afterwards, so the next run isn't blocked.
    expect(d.store.lockHolder("prep")).toBeNull();
  });

  it("takes over a lock left by a process that exited, or one that's hours old", async () => {
    const d = await setup();
    d.store.setMeta("lock:prep", JSON.stringify({ pid: DEAD_PID, since: d.store.now() }));
    expect(d.store.tryLock("prep")).toBeNull();
    expect(d.store.lockHolder("prep")?.pid).toBe(process.pid);

    d.store.setMeta(
      "lock:prep",
      JSON.stringify({ pid: process.pid, since: "2026-11-17T00:00:00.000Z" }),
    );
    expect(d.store.tryLock("prep", 60 * 60_000)).toBeNull();
    d.store.unlock("prep");
    expect(d.store.lockHolder("prep")).toBeNull();
  });

  it("releases the lock when a run stops early at the usage limit", async () => {
    const d = await setup();
    const llm = new FakeLlm({
      draft: () => {
        throw new UsageLimitError("resets at 5pm");
      },
    });
    expect(await runPrep({ ...d, llm })).toMatchObject({ paused: true, busy: false });
    expect(d.store.lockHolder("prep")).toBeNull();
  });
});
