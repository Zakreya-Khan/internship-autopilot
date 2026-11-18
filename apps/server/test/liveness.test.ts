import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLlm } from "@ia/ai";
import type { Posting } from "@ia/core";
import { makePosting, testProfile } from "@ia/core/testing";
import type { LivenessResult } from "@ia/sources";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/api.ts";
import type { LivenessCheck } from "../src/liveness.ts";
import { ensureOpen, makeLivenessCheck } from "../src/liveness.ts";
import { runScoring, runSourcing } from "../src/pipeline.ts";
import type { PrepDeps } from "../src/prep.ts";
import { runPrep } from "../src/prep.ts";
import { memoryStore, routeFetch, SIMPLIFY_URL, simplifyRow } from "./helpers.ts";

const profile = testProfile();
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const expired: LivenessResult = {
  verdict: "expired",
  code: "greenhouse_api_gone",
  reason: "HTTP 404",
  via: "api",
};
const active: LivenessResult = { verdict: "active", code: "ok", reason: "listed", via: "api" };
const uncertain: LivenessResult = {
  verdict: "uncertain",
  code: "access_blocked",
  reason: "HTTP 403",
  via: "page",
};

/** A scripted check: closed for the ids given, the default answer for the rest. */
function scripted(closedIds: string[], otherwise: LivenessResult = active) {
  const asked: string[] = [];
  const check: LivenessCheck = async (p: Posting) => {
    asked.push(p.id);
    return closedIds.includes(p.id) ? expired : otherwise;
  };
  return { check, asked };
}

function deps(liveness: LivenessCheck | null, llm: FakeLlm | null = null) {
  const out = mkdtempSync(join(tmpdir(), "ia-out-"));
  dirs.push(out);
  const d: PrepDeps & { store: ReturnType<typeof memoryStore> } = {
    store: memoryStore(),
    profile,
    fetch: routeFetch({}),
    llm,
    outDir: out,
    liveness,
    now: () => new Date("2026-11-17T12:00:00Z"),
  };
  return d;
}

describe("open-posting check in prep", () => {
  it("skips a closed posting before any tokens are spent, and prepares the next one", async () => {
    const llm = new FakeLlm({
      draft: () => {
        throw new Error("drafting should not be reached in this test");
      },
    });
    const closedOne = makePosting({ id: "greenhouse:exampleco:1", company: "Closed Co" });
    const openOne = makePosting({ id: "greenhouse:exampleco:2", company: "Open Co" });
    const { check, asked } = scripted([closedOne.id]);
    const d = deps(check, null);
    d.store.savePostings([closedOne, openOne]);
    await runScoring(d);
    const r = await runPrep(d, { limit: 1 });
    expect(r).toMatchObject({ prepared: 1, closed: 1 });
    expect(asked).toEqual(expect.arrayContaining([closedOne.id, openOne.id]));
    expect(d.store.applicationForPosting(closedOne.id)).toBeNull();
    expect(d.store.getPosting(closedOne.id)!.isOpen).toBe(false);
    expect(d.store.getLiveness(closedOne.id)).toMatchObject({ verdict: "expired" });
    expect(llm.requests).toHaveLength(0);
  });

  it("keeps a posting when the answer is uncertain", async () => {
    const p = makePosting({ id: "greenhouse:exampleco:3" });
    const d = deps(async () => uncertain);
    d.store.savePostings([p]);
    await runScoring(d);
    expect(await runPrep(d, { limit: 5 })).toMatchObject({ prepared: 1, closed: 0 });
    expect(d.store.getPosting(p.id)!.isOpen).toBe(true);
  });

  it("reuses a recent answer and never rechecks an expired one", async () => {
    const p = makePosting({ id: "greenhouse:exampleco:4" });
    const d = deps(null);
    d.store.savePostings([p]);
    let n = 0;
    const check: LivenessCheck = async () => (++n === 1 ? active : expired);
    const t0 = new Date("2026-11-17T12:00:00Z");
    await ensureOpen(d.store, p, check, 60_000, t0);
    expect((await ensureOpen(d.store, p, check, 24 * 3600_000, t0)).verdict).toBe("active");
    expect(n).toBe(1);
    const later = new Date("2026-11-20T12:00:00Z");
    expect((await ensureOpen(d.store, p, check, 60_000, later)).verdict).toBe("expired");
    expect((await ensureOpen(d.store, p, check, 60_000, later)).verdict).toBe("expired");
    expect(n).toBe(2);
  });

  it("a check that throws counts as uncertain", async () => {
    const p = makePosting({ id: "greenhouse:exampleco:5" });
    const d = deps(null);
    d.store.savePostings([p]);
    const r = await ensureOpen(d.store, p, async () => Promise.reject(new Error("boom")), 1000);
    expect(r.verdict).toBe("uncertain");
  });
});

describe("expired postings stay closed", () => {
  it("a list that still shows a closed posting doesn't reopen it", async () => {
    const d = deps(null);
    d.fetch = routeFetch({ [SIMPLIFY_URL]: [simplifyRow()] });
    await runSourcing(d);
    const [p] = d.store.allPostings();
    expect(p!.isOpen).toBe(true);
    d.store.recordLiveness(p!.id, expired);
    await runSourcing(d);
    expect(d.store.getPosting(p!.id)!.isOpen).toBe(false);
  });
});

describe("open-posting check in the submit session", () => {
  it("skips and reports an approved application whose posting closed", async () => {
    const closedP = makePosting({
      id: "greenhouse:exampleco:10",
      company: "Gone Co",
      deadline: "2026-11-20",
    });
    const openP = makePosting({ id: "greenhouse:exampleco:11", company: "Here Co" });
    const { check } = scripted([closedP.id]);
    const d = deps(null);
    d.store.savePostings([closedP, openP]);
    for (const p of [closedP, openP]) {
      const a = d.store.createApplication(p.id, "A");
      d.store.setStatus(a.id, "ready");
      d.store.setStatus(a.id, "approved");
    }
    const app = buildServer({
      store: d.store,
      profile,
      token: "t",
      outDir: d.outDir,
      snapshotsDir: d.outDir,
      uiDir: null,
      allowedHosts: ["h"],
      liveness: check,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/session/next",
      headers: { host: "h", "x-ia-token": "t" },
      payload: {},
    });
    const body = res.json() as {
      done: boolean;
      remaining: number;
      closed: { company: string }[];
      application: { company: string };
    };
    expect(body.done).toBe(false);
    expect(body.closed.map((c) => c.company)).toEqual(["Gone Co"]);
    expect(body.application.company).toBe("Here Co");
    expect(body.remaining).toBe(1);
    expect(d.store.applicationForPosting(closedP.id)!.status).toBe("skipped");
    await app.close();
  });
});

describe("makeLivenessCheck", () => {
  it("asks the board API through the given fetch", async () => {
    const urls: string[] = [];
    const check = makeLivenessCheck(async (url) => {
      urls.push(url);
      return new Response("{}", { status: 404 });
    });
    const r = await check(
      makePosting({
        boardToken: "exampleco",
        atsJobId: "42",
        applyUrl: "https://job-boards.greenhouse.io/exampleco/jobs/42",
      }),
    );
    expect(r.verdict).toBe("expired");
    expect(urls[0]).toBe("https://boards-api.greenhouse.io/v1/boards/exampleco/jobs/42");
  });
});
