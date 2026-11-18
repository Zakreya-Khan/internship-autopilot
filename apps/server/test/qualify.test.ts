import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FitScore, Posting } from "@ia/core";
import { makePosting, testProfile } from "@ia/core/testing";
import { HostRateLimiter } from "@ia/sources";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/api.ts";
import { runEnrichment } from "../src/pipeline.ts";
import { qualifyCandidates } from "../src/qualify.ts";
import { memoryStore, routeFetch } from "./helpers.ts";

const profile = testProfile(); // GPA 3.70, bachelors, graduating 2028
const NOW = new Date("2026-11-18T00:00:00Z");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fit(over: Partial<FitScore["match"]> = {}): FitScore {
  return {
    score: 80,
    tier: "A",
    components: {
      skills: 20,
      roleFamily: 25,
      education: 15,
      location: 10,
      company: 0,
      freshness: 10,
    },
    match: { required: [], matched: [], missing: [], method: "keywords", ...over },
  };
}

function seed() {
  const store = memoryStore();
  const meets = makePosting({
    id: "p-meets",
    company: "Meets Co",
    degrees: [],
    descriptionText:
      "Minimum Qualifications\nMinimum GPA of 3.0\nCurrently pursuing a Bachelor's degree",
  });
  const close = makePosting({
    id: "p-close",
    company: "Close Co",
    degrees: [],
    descriptionText:
      "Minimum Qualifications\nMinimum GPA of 3.9\nCurrently pursuing a Bachelor's degree",
  });
  const vague = makePosting({ id: "p-vague", descriptionText: "Come build things with us." });
  store.savePostings([meets, close, vague]);
  for (const p of [meets, close, vague]) store.saveScore(p.id, true, [], fit(), "h");
  return { store, meets, close, vague };
}

describe("qualifyCandidates", () => {
  it("separates postings you meet from ones one requirement short, and skips vague ones", () => {
    const { store } = seed();
    const meets = qualifyCandidates(store, profile, { verdict: "meets", now: NOW });
    const close = qualifyCandidates(store, profile, { verdict: "close", now: NOW });
    expect(meets.map((r) => r.company)).toEqual(["Meets Co"]);
    expect(close.map((r) => r.company)).toEqual(["Close Co"]);
    expect(close[0]!.qualification.checks.find((c) => c.met === false)).toMatchObject({
      kind: "gpa",
    });
  });

  it("uses the stored model requirement match for skills", () => {
    const store = memoryStore();
    const p = makePosting({ id: "p1", degrees: [], descriptionText: "Minimum GPA of 3.0" });
    store.savePostings([p]);
    store.saveScore(
      "p1",
      true,
      [],
      fit({
        required: ["Python", "Rust"],
        matched: ["Python"],
        missing: ["Rust"],
        method: "model",
      }),
      "h",
    );
    const close = qualifyCandidates(store, profile, { verdict: "close", now: NOW });
    expect(close[0]!.qualification.checks.find((c) => c.met === false)).toMatchObject({
      kind: "skill",
      need: "Rust",
    });
  });

  it("filters by tier and links a prepared application", () => {
    const { store, meets } = seed();
    store.createApplication(meets.id, "A");
    expect(qualifyCandidates(store, profile, { verdict: "meets", tier: "B", now: NOW })).toEqual(
      [],
    );
    const [row] = qualifyCandidates(store, profile, { verdict: "meets", tier: "A", now: NOW });
    expect(row!.applicationId).toBe(store.applicationForPosting(meets.id)!.id);
  });
});

describe("GET /api/qualify", () => {
  const HOST = "127.0.0.1:4317";
  const TOKEN = "t".repeat(32);
  const server = (store = seed().store) => {
    const snapshots = mkdtempSync(join(tmpdir(), "ia-q-"));
    dirs.push(snapshots);
    return buildServer({
      store,
      profile,
      token: TOKEN,
      outDir: snapshots,
      snapshotsDir: snapshots,
      uiDir: null,
      allowedHosts: [HOST],
    });
  };

  it("needs the token", async () => {
    const res = await server().inject({ url: "/api/qualify", headers: { host: HOST } });
    expect(res.statusCode).toBe(401);
  });

  it("lists postings you meet by default, and close ones on request", async () => {
    const app = server();
    const headers = { host: HOST, "x-ia-token": TOKEN };
    const meets = (await app.inject({ url: "/api/qualify", headers })).json() as {
      company: string;
    }[];
    expect(meets.map((r) => r.company)).toEqual(["Meets Co"]);
    const close = (await app.inject({ url: "/api/qualify?verdict=close", headers })).json() as {
      company: string;
    }[];
    expect(close.map((r) => r.company)).toEqual(["Close Co"]);
  });
});

describe("Lever forms during enrichment", () => {
  const applyPage = `<form id="application-form">
    <input type="text" name="name" required><input name="email" type="email" required>
    <input type="hidden" name="cards[c1][baseTemplate]" value="${JSON.stringify({
      text: "Questions",
      type: "posting",
      fields: [{ type: "textarea", text: "Why Acme?", required: true }],
    }).replace(/"/g, "&quot;")}">
  </form>`;

  it("stores a Lever posting's real questions with its description", async () => {
    const store = memoryStore();
    const lever: Posting = makePosting({
      id: "lever:acme:abc",
      company: "Acme",
      ats: "lever",
      boardToken: "acme",
      atsJobId: "abc",
      descriptionText: "SQL and Go.",
      questions: null,
    });
    store.savePostings([lever]);
    store.saveScore(lever.id, true, [], fit(), "h");
    const fetchFn = async (url: string) =>
      url.startsWith("https://jobs.lever.co/acme/abc/apply")
        ? new Response(applyPage)
        : routeFetch({
            "https://api.lever.co/v0/postings/acme/abc": {
              id: "abc",
              text: "Intern",
              hostedUrl: "h",
              descriptionPlain: "SQL and Go.",
            },
          })(url);
    const deps = { store, profile, fetch: fetchFn, llm: null, now: () => NOW };
    // It has a description already, but no questions yet: still worth a visit.
    const r = await runEnrichment(deps, { limiter: new HostRateLimiter(0) });
    expect(r).toEqual({ tried: 1, enriched: 1, failed: 0 });
    expect(store.getPosting(lever.id)!.questions?.map((q) => q.key)).toEqual([
      "name",
      "email",
      "cards[c1][field0]",
    ]);
    // Once stored, it isn't fetched again.
    expect(await runEnrichment(deps, { limiter: new HostRateLimiter(0) })).toMatchObject({
      tried: 0,
    });
  });
});
