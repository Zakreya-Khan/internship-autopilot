import { FakeLlm } from "@ia/ai";
import { makePosting, testProfile } from "@ia/core/testing";
import { describe, expect, it } from "vitest";
import { HostRateLimiter } from "@ia/sources";
import { runEnrichment, runScoring, runSourcing } from "../src/pipeline.ts";
import { greenhouseBoard, memoryStore, routeFetch, SIMPLIFY_URL, simplifyRow } from "./helpers.ts";

const GH = "https://boards-api.greenhouse.io/v1/boards/exampleco/jobs";

describe("Store", () => {
  it("migrates a fresh database to the latest version", () => {
    const store = memoryStore();
    const v = store.db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBe(3);
  });

  it("enforces the status machine and stamps times", () => {
    const store = memoryStore();
    store.savePostings([makePosting({ id: "p1" })]);
    const app = store.createApplication("p1", "B");
    expect(() => store.setStatus(app.id, "submitted")).toThrow(/can't move/);
    store.setStatus(app.id, "ready");
    const approved = store.setStatus(app.id, "approved");
    expect(approved.approved_at).not.toBeNull();
    expect(store.events(app.id).map((e) => e.type)).toEqual(["created", "status", "status"]);
  });

  it("logs model cost per call", () => {
    const store = memoryStore();
    store.logLlmCall("draft", "claude-opus-5-5", {
      input_tokens: 5000,
      output_tokens: 6000,
      cache_read_input_tokens: 10000,
    });
    expect(store.costSummary()).toEqual([{ purpose: "draft", calls: 1, usd: 0.142 }]);
  });
});

describe("runSourcing", () => {
  const profile = testProfile();

  it("merges the list and the API into one record per role", async () => {
    const store = memoryStore();
    const fetch = routeFetch({
      [SIMPLIFY_URL]: [
        simplifyRow(),
        simplifyRow({
          id: "s2",
          title: "Hardware Intern",
          terms: ["Fall 2026"],
          url: "https://x.test/2",
        }),
      ],
      [GH]: greenhouseBoard([
        { id: 501, title: "Software Engineer Intern" },
        { id: 502, title: "Data Intern (Summer 2027)" },
      ]),
    });
    const r = await runSourcing({ store, profile, fetch, llm: null });
    // The Fall 2026 row is dropped at ingest; 501 appears in both sources and is merged.
    expect(r).toMatchObject({ fetched: 4, kept: 3, added: 2, merged: 1, errors: [] });
    const p = store.getPosting("greenhouse:exampleco:501")!;
    expect(p.sources.sort()).toEqual(["greenhouse", "simplify"]);
    expect(p.descriptionText).toBe("Python and TypeScript.");
  });

  it("closes a role after two polls without it", async () => {
    const store = memoryStore();
    const deps = { store, profile, llm: null };
    await runSourcing(
      { ...deps, fetch: routeFetch({ [GH]: greenhouseBoard([{ id: 9, title: "SWE Intern" }]) }) },
      { includeSimplify: false },
    );
    const empty = routeFetch({ [GH]: greenhouseBoard([]) });
    await runSourcing({ ...deps, fetch: empty }, { includeSimplify: false });
    expect(store.getPosting("greenhouse:exampleco:9")!.isOpen).toBe(true);
    const r = await runSourcing({ ...deps, fetch: empty }, { includeSimplify: false });
    expect(r.closed).toBe(1);
    expect(store.getPosting("greenhouse:exampleco:9")!.isOpen).toBe(false);
  });

  it("keeps going when a board fails", async () => {
    const store = memoryStore();
    const r = await runSourcing(
      { store, profile, llm: null, fetch: routeFetch({}) },
      { includeSimplify: false },
    );
    expect(r.errors[0]).toMatch(/greenhouse:exampleco/);
  });
});

describe("runScoring", () => {
  const profile = testProfile();
  const now = () => new Date("2026-11-17T12:00:00Z");

  function seeded() {
    const store = memoryStore();
    store.savePostings([
      makePosting({ id: "good", postedAt: "2026-11-16T00:00:00Z" }),
      makePosting({ id: "quant", roleFamily: "quant", title: "Quant Trading Intern" }),
      makePosting({ id: "nodesc", descriptionText: null }),
    ]);
    return store;
  }

  it("drops filtered postings, scores the rest, and calls the model only once per input", async () => {
    const store = seeded();
    const llm = new FakeLlm({
      requirements: () => ({
        required: ["Python", "TypeScript"],
        matched: ["Python", "TypeScript"],
      }),
    });
    const first = await runScoring({ store, profile, llm, fetch: routeFetch({}), now });
    expect(first).toMatchObject({ considered: 3, passed: 2, dropped: 1, modelCalls: 1, reused: 0 });
    expect(store.getScore("quant")).toMatchObject({
      passed: false,
      filter_reasons: ["role family quant not selected"],
    });
    const good = store.getScore("good")!;
    expect(good.fit).toMatchObject({ tier: "A", match: { method: "model" } });
    expect(store.getScore("nodesc")!.fit?.match.method).toBe("no_description");

    const second = await runScoring({ store, profile, llm, fetch: routeFetch({}), now });
    expect(second).toMatchObject({ modelCalls: 0, reused: 2 });
    expect(llm.requests).toHaveLength(1);
  });

  it("falls back to keywords when the model call fails", async () => {
    const store = seeded();
    const llm = new FakeLlm({});
    const logs: string[] = [];
    const r = await runScoring({
      store,
      profile,
      llm,
      fetch: routeFetch({}),
      now,
      log: (m) => logs.push(m),
    });
    expect(r.passed).toBe(2);
    expect(store.getScore("good")!.fit?.match.method).toBe("keywords");
    expect(logs[0]).toMatch(/using keywords/);
  });

  it("ranks candidates best first", async () => {
    const store = seeded();
    await runScoring({ store, profile, llm: null, fetch: routeFetch({}), now });
    const ranked = store.rankedCandidates();
    expect(ranked.map((r) => r.posting.id)).toEqual(["good", "nodesc"]);
  });
});

describe("runEnrichment", () => {
  const profile = testProfile();

  it("fills descriptions and Greenhouse forms for top candidates, then scoring uses them", async () => {
    const store = memoryStore();
    store.savePostings([
      makePosting({ id: "greenhouse:exampleco:77", atsJobId: "77", descriptionText: null }),
      makePosting({
        id: "lever:acme:abc",
        company: "Acme",
        ats: "lever",
        boardToken: "acme",
        atsJobId: "abc",
        descriptionText: null,
      }),
      makePosting({
        id: "url:x",
        ats: "other",
        boardToken: null,
        atsJobId: null,
        descriptionText: null,
      }),
    ]);
    const now = () => new Date("2026-11-17T12:00:00Z");
    const fetch = routeFetch({
      [`${GH}/77?questions=true`]: {
        id: 77,
        title: "SWE Intern",
        absolute_url: "x",
        content: "&lt;p&gt;Python, TypeScript, React. Must be a U.S. citizen.&lt;/p&gt;",
        application_deadline: "2026-12-01T00:00:00Z",
        questions: [
          { label: "Email", required: true, fields: [{ name: "email", type: "input_text" }] },
        ],
      },
      "https://api.lever.co/v0/postings/acme/abc": {
        id: "abc",
        text: "Intern",
        hostedUrl: "h",
        descriptionPlain: "SQL and Go.",
      },
    });
    const deps = { store, profile, fetch, llm: null, now };
    await runScoring(deps);
    expect(store.getScore("greenhouse:exampleco:77")!.fit!.match.method).toBe("no_description");
    const r = await runEnrichment(deps, { limiter: new HostRateLimiter(0) });
    expect(r).toEqual({ tried: 2, enriched: 2, failed: 0 });
    const gh = store.getPosting("greenhouse:exampleco:77")!;
    expect(gh).toMatchObject({ deadline: "2026-12-01", sponsorship: "citizenship_required" });
    expect(gh.questions?.[0]?.key).toBe("email");
    await runScoring(deps);
    // Now known to require citizenship, which the test profile lacks: dropped.
    expect(store.getScore("greenhouse:exampleco:77")!.passed).toBe(false);
    expect(store.getScore("lever:acme:abc")!.fit!.match.method).toBe("keywords");
  });
});
