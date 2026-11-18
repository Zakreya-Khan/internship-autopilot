// The review UI's background jobs and the endpoints that drive them. Fictional data, fake network
// and FakeLlm only: no real requests, no model calls.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DraftOutput } from "@ia/ai";
import { FakeLlm } from "@ia/ai";
import type { FormQuestion } from "@ia/core";
import { makePosting, testProfile } from "@ia/core/testing";
import type { FetchFn } from "@ia/sources";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer, LAUNCH_TTL_MS, sameSite } from "../src/api.ts";
import { searchPostings, skipPostings } from "../src/discover.ts";
import type { JobContext } from "../src/jobs.ts";
import { JobConflict, JobRunner } from "../src/jobs.ts";
import { prepareOne } from "../src/prep.ts";
import { greenhouseBoard, memoryStore, routeFetch, SIMPLIFY_URL, simplifyRow } from "./helpers.ts";

const profile = testProfile();
const GH = "https://boards-api.greenhouse.io/v1/boards/exampleco/jobs";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "ia-jobs-"));
  dirs.push(d);
  return d;
};

const QUESTIONS: FormQuestion[] = [
  { key: "first_name", label: "First Name", required: true, type: "text" },
  { key: "email", label: "Email", required: true, type: "text" },
  { key: "resume", label: "Resume/CV", required: true, type: "file" },
];
const draft = (): DraftOutput => ({
  resume: { entries: [], skills_order: ["python"], courses: [] },
  answers: [],
  cover_letter: null,
  fit_note: { why: "Python.", gaps: "None noted." },
});
const llm = () => new FakeLlm({ draft, truth_check: () => ({ verdicts: [] }) });

function runner(over: Partial<JobContext> = {}) {
  const store = memoryStore();
  const ctx: JobContext = {
    store,
    profile: () => profile,
    llm: () => null,
    provider: () => "api",
    llmReason: () => "no key (test)",
    fetch: routeFetch({}),
    outDir: tempDir(),
    home: tempDir(),
    liveness: () => null,
    now: () => new Date("2026-11-17T12:00:00Z"),
    ...over,
  };
  return { store, ctx, jobs: new JobRunner(ctx) };
}

/** A fetch that waits until released, to hold a job in "running". */
function gatedFetch(): { fetch: FetchFn; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return {
    fetch: async (url) => {
      await gate;
      return routeFetch({ [SIMPLIFY_URL]: [simplifyRow()] })(url);
    },
    release,
  };
}

describe("JobRunner", () => {
  it("finds postings in the background, with progress and a plain summary", async () => {
    const fetch = routeFetch({
      [SIMPLIFY_URL]: [simplifyRow()],
      [GH]: greenhouseBoard([{ id: 501, title: "Software Engineer Intern" }]),
    });
    const { jobs, store } = runner({ fetch });
    const job = jobs.start("refresh", { useModel: false });
    expect(job).toMatchObject({ status: "running", label: "Find postings" });
    await jobs.idle();
    const done = jobs.get(job.id)!;
    expect(done.status).toBe("done");
    expect(done.summary).toMatch(/^Read 2 listings: 1 new posting, 1 updated, 0 closed\./);
    expect(done.progress).not.toBeNull();
    expect(store.allPostings()).toHaveLength(1);
  });

  it("only polls the sources and company you chose", async () => {
    const fetch = routeFetch({
      [SIMPLIFY_URL]: [
        simplifyRow(),
        simplifyRow({ id: "s2", company_name: "Other Co", url: "https://x.test/2" }),
      ],
      [GH]: greenhouseBoard([{ id: 501, title: "Software Engineer Intern" }]),
    });
    const { jobs, store } = runner({ fetch });
    jobs.start("refresh", { useModel: false, watchlist: false, company: "other" });
    await jobs.idle();
    expect(store.allPostings().map((p) => p.company)).toEqual(["Other Co"]);
  });

  it("runs one job per lane, and cancels between items", async () => {
    const gated = gatedFetch();
    const { jobs } = runner({ fetch: gated.fetch });
    const refresh = jobs.start("refresh", { useModel: false, watchlist: false });
    expect(() => jobs.start("prep")).toThrow(JobConflict);
    expect(() => jobs.start("prep")).toThrow(/"Find postings" is still running/);
    // A different lane runs alongside.
    const stories = jobs.start("stories");
    jobs.cancel(refresh.id);
    gated.release();
    await jobs.idle();
    expect(jobs.get(refresh.id)).toMatchObject({ status: "cancelled" });
    expect(jobs.get(refresh.id)!.summary).toMatch(/^Cancelled\./);
    expect(jobs.get(stories.id)).toMatchObject({ status: "done" });
    expect(jobs.list().map((j) => j.id)).toEqual([stories.id, refresh.id]);
  });

  it("prepares exactly the postings you picked", async () => {
    const { jobs, store } = runner({ llm: () => llm() });
    const picked = makePosting({ id: "p1", questions: QUESTIONS });
    const other = makePosting({ id: "p2", company: "Other Co", questions: QUESTIONS });
    store.savePostings([picked, other]);
    const job = jobs.start("prep", { postingIds: ["p1"], skipOpenCheck: true });
    await jobs.idle();
    expect(jobs.get(job.id)).toMatchObject({ status: "done" });
    expect(jobs.get(job.id)!.summary).toMatch(/^Prepared 1: /);
    expect(store.applicationForPosting("p1")).not.toBeNull();
    expect(store.applicationForPosting("p2")).toBeNull();
  });

  it("explains failures in plain language", async () => {
    const { jobs } = runner();
    const mail = jobs.start("email-sync", { path: "/no/such/export.mbox" });
    await jobs.idle();
    expect(jobs.get(mail.id)).toMatchObject({ status: "failed" });
    expect(jobs.get(mail.id)!.error).toMatch(/doesn't exist/);
    const out = jobs.start("outreach", { postingId: "p1" });
    await jobs.idle();
    expect(jobs.get(out.id)!.error).toMatch(/Outreach drafts need Claude/);
    const batch = jobs.start("batch-submit");
    await jobs.idle();
    expect(jobs.get(batch.id)!.error).toMatch(/needs an Anthropic API key/);
  });

  it("prepares Tier B one at a time on the Claude CLI instead of batching", async () => {
    const { jobs } = runner({ provider: () => "cli", llm: () => llm() });
    const job = jobs.start("batch-submit");
    await jobs.idle();
    expect(jobs.get(job.id)).toMatchObject({ status: "done" });
    expect(jobs.get(job.id)!.summary).toMatch(/No batch on the Claude CLI/);
    expect(jobs.get(job.id)!.log.join(" ")).toMatch(/has no Batch API/);
  });
});

describe("Discover", () => {
  it("searches, filters, sorts and pages postings", async () => {
    const store = memoryStore();
    store.savePostings([
      makePosting({
        id: "a",
        company: "Alpha Co",
        title: "Software Engineer Intern",
        locations: ["Boston, MA"],
      }),
      makePosting({ id: "b", company: "Beta Co", title: "Data Intern", locations: ["Remote"] }),
      makePosting({ id: "c", company: "Gamma Co", title: "ML Intern", isOpen: false }),
    ]);
    const fit = (score: number, tier: "A" | "B" | "C") => ({
      score,
      tier,
      components: { skills: 0, roleFamily: 0, education: 0, location: 0, company: 0, freshness: 0 },
      match: { required: [], matched: [], missing: [], method: "keywords" as const },
    });
    store.saveScore("a", true, [], fit(90, "A"), "h");
    store.saveScore("b", true, [], fit(65, "B"), "h");
    store.saveScore("c", true, [], fit(70, "B"), "h");
    expect(searchPostings(store, {}).items.map((r) => r.id)).toEqual(["a", "b"]);
    expect(searchPostings(store, { open: "all" }).items.map((r) => r.id)).toEqual(["a", "c", "b"]);
    expect(searchPostings(store, { tier: "B" }).items.map((r) => r.id)).toEqual(["b"]);
    expect(searchPostings(store, { q: "software boston" }).items.map((r) => r.id)).toEqual(["a"]);
    expect(searchPostings(store, { location: "remote" }).items.map((r) => r.id)).toEqual(["b"]);
    expect(searchPostings(store, { sort: "company", limit: 1, offset: 1 })).toMatchObject({
      total: 2,
      items: [{ id: "b" }],
    });
    expect(skipPostings(store, ["b"])).toEqual({ skipped: 1, left: 0 });
    expect(searchPostings(store, { status: "none" }).items.map((r) => r.id)).toEqual(["a"]);
    expect(searchPostings(store, { status: "skipped" }).items[0]).toMatchObject({
      id: "b",
      application: { status: "skipped" },
    });
  });
});

describe("API: jobs, search and Open & fill", () => {
  const HOST = "127.0.0.1:4317";
  async function setup(over: Partial<JobContext> = { llm: () => llm() }) {
    const { store, jobs, ctx } = runner(over);
    const app = buildServer({
      store,
      profile,
      token: "t",
      outDir: ctx.outDir,
      snapshotsDir: tempDir(),
      uiDir: null,
      allowedHosts: [HOST],
      jobs,
      home: ctx.home,
    });
    const call = (method: "GET" | "POST", url: string, payload?: object, origin?: string) =>
      app.inject({
        method,
        url,
        ...(payload ? { payload } : {}),
        headers: { host: HOST, "x-ia-token": "t", ...(origin ? { origin } : {}) },
      });
    return { store, jobs, app, call, ctx };
  }

  it("starts, lists, reads and cancels jobs; refuses a second one in the same lane", async () => {
    const gated = gatedFetch();
    const { call, jobs, app } = await setup({ fetch: gated.fetch });
    const started = await call("POST", "/api/jobs", {
      kind: "refresh",
      params: { useModel: false, watchlist: false },
    });
    expect(started.statusCode).toBe(202);
    const id = started.json().id;
    const clash = await call("POST", "/api/jobs", { kind: "prep" });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error).toMatch(/still running/);
    expect((await call("POST", "/api/jobs", { kind: "nope" })).statusCode).toBe(400);
    expect((await call("POST", `/api/jobs/${id}/cancel`)).statusCode).toBe(200);
    gated.release();
    await jobs.idle();
    expect((await call("GET", `/api/jobs/${id}`)).json()).toMatchObject({ status: "cancelled" });

    // Stories without a model: one per entry, readable afterwards.
    await call("POST", "/api/jobs", { kind: "stories" });
    await jobs.idle();
    expect((await call("GET", "/api/jobs")).json()).toHaveLength(2);
    expect((await call("GET", "/api/stories")).json().markdown).toContain("#");
    expect((await call("GET", "/api/jobs/999")).statusCode).toBe(404);
    await app.close();
  });

  it("keeps jobs, search and launches to the review UI, never the extension", async () => {
    const { call, app } = await setup();
    const ext = "chrome-extension://abc";
    for (const [m, u] of [
      ["GET", "/api/jobs"],
      ["POST", "/api/jobs"],
      ["GET", "/api/postings"],
      ["GET", "/api/summary"],
      ["POST", "/api/applications/1/launch"],
    ] as const)
      expect((await call(m, u, m === "POST" ? {} : undefined, ext)).statusCode).toBe(403);
    expect((await call("GET", "/api/summary", undefined, `http://${HOST}`)).statusCode).toBe(200);
    await app.close();
  });

  it("summarizes what to do next", async () => {
    const { call, store, app } = await setup();
    const p = makePosting({ id: "p1" });
    store.savePostings([p]);
    const a = store.createApplication("p1", "A");
    store.setStatus(a.id, "needs_input");
    const s = (await call("GET", "/api/summary")).json();
    expect(s).toMatchObject({ needsInput: 1, ready: 0, approved: 0, postings: { open: 1 } });
    await app.close();
  });

  it("Open & fill hands one approved application to the extension, once, on its own site", async () => {
    const { call, store, ctx, app } = await setup();
    const posting = makePosting({ id: "p1", questions: QUESTIONS });
    store.savePostings([posting]);
    const { applicationId: id } = await prepareOne(
      { store, profile, fetch: routeFetch({}), llm: llm(), outDir: ctx.outDir },
      posting,
      "A",
    );
    // Not approved yet.
    expect((await call("POST", `/api/applications/${id}/launch`)).statusCode).toBe(409);
    if (store.getApplication(id)!.status === "needs_input") store.setStatus(id, "ready");
    store.setStatus(id, "approved");
    const launched = (await call("POST", `/api/applications/${id}/launch`)).json();
    expect(launched.applyUrl).toBe(posting.applyUrl);

    const other = await call("POST", "/api/session/launch", { url: "https://example.org/jobs" });
    expect(other.json()).toEqual({ application: null });
    const page = new URL(posting.applyUrl);
    const hit = await call("POST", "/api/session/launch", { url: `${page.origin}/elsewhere` });
    expect(hit.json().application).toMatchObject({ id, company: posting.company });
    expect(hit.json().application.files.resume.base64).toBeTruthy();
    // One launch, one fill.
    expect((await call("POST", "/api/session/launch", { url: posting.applyUrl })).json()).toEqual({
      application: null,
    });
    expect(store.getApplication(id)!.status).toBe("approved"); // nothing is ever submitted
    await app.close();
  });

  it("matches the site, not the subdomain, and expires launches", () => {
    expect(
      sameSite("https://boards.greenhouse.io/x/jobs/1", "https://job-boards.greenhouse.io/x"),
    ).toBe(true);
    expect(sameSite("https://jobs.lever.co/x", "https://job-boards.greenhouse.io/x")).toBe(false);
    expect(sameSite("not a url", "https://jobs.lever.co/x")).toBe(false);
    expect(LAUNCH_TTL_MS).toBe(10 * 60 * 1000);
  });
});
