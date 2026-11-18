import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DraftOutput } from "@ia/ai";
import { FakeLlm } from "@ia/ai";
import type { FormQuestion } from "@ia/core";
import { makePosting, testProfile } from "@ia/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/api.ts";
import type { PrepDeps } from "../src/prep.ts";
import { prepareOne, runPrep, selectForPrep } from "../src/prep.ts";
import { runScoring } from "../src/pipeline.ts";
import { memoryStore, routeFetch } from "./helpers.ts";

const profile = testProfile();
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const QUESTIONS: FormQuestion[] = [
  { key: "first_name", label: "First Name", required: true, type: "text" },
  { key: "email", label: "Email", required: true, type: "text" },
  { key: "resume", label: "Resume/CV", required: true, type: "file" },
  {
    key: "question_1",
    label: "Why do you want to work at Example Co?",
    required: true,
    type: "textarea",
    maxLength: 500,
  },
  {
    key: "question_2",
    label: "Will you require visa sponsorship?",
    required: true,
    type: "select",
    options: ["Yes", "No"],
  },
  {
    key: "question_3",
    label: "Do you know anyone who works here?",
    required: true,
    type: "select",
    options: ["Yes", "No"],
  },
];

function draftOutput(over: Partial<DraftOutput> = {}): DraftOutput {
  return {
    resume: {
      entries: [
        {
          entry_id: "exp.lab",
          bullets: [
            {
              text: "Cut the nightly processing job from 6 hours to 40 minutes",
              fact_ids: ["exp.lab.f2"],
            },
            // Invented: Kubernetes and "10x" appear nowhere in the profile.
            { text: "Scaled a Python pipeline 10x on Kubernetes", fact_ids: ["exp.lab.f1"] },
          ],
        },
        {
          entry_id: "proj.app",
          bullets: [
            {
              text: "Wrote a web app that builds conflict-free class schedules",
              fact_ids: ["proj.app.f1"],
            },
          ],
        },
      ],
      skills_order: ["python", "typescript", "react", "sql"],
      courses: ["databases"],
    },
    answers: [
      {
        question_key: "question_1",
        text: "I like turning messy data into tools people use, which is what Example Co does.",
        fact_ids: ["ans.why_field"],
      },
    ],
    cover_letter: null,
    fit_note: { why: "Python and TypeScript.", gaps: "None noted." },
    ...over,
  };
}

function deps(llm: FakeLlm | null): PrepDeps & { store: ReturnType<typeof memoryStore> } {
  const out = mkdtempSync(join(tmpdir(), "ia-out-"));
  dirs.push(out);
  return {
    store: memoryStore(),
    profile,
    fetch: routeFetch({}),
    llm,
    outDir: out,
    now: () => new Date("2026-11-17T12:00:00Z"),
  };
}

const passAll = () => ({ verdicts: [] });

describe("prep", () => {
  it("drafts, reverts invented resume bullets, renders a PDF and blocks on questions only you can answer", async () => {
    const llm = new FakeLlm({ draft: () => draftOutput(), truth_check: passAll });
    const d = deps(llm);
    const posting = makePosting({ id: "p1", questions: QUESTIONS });
    d.store.savePostings([posting]);
    const r = await prepareOne(d, posting, "A");
    expect(r.status).toBe("needs_input");
    expect(r.issues.map((i) => i.problem)).toEqual(
      expect.arrayContaining([
        'number "10x" isn\'t in the cited facts',
        "mentions kubernetes, which isn't in your profile",
      ]),
    );
    const app = d.store.getApplication(r.applicationId)!;
    const variant = d.store.getResumeVariant(app.resume_variant_id!)!;
    const doc = (variant.plan as { doc: { experience: { bullets: { text: string }[] }[] } }).doc;
    // The invented bullet fell back to the original fact wording.
    expect(doc.experience[0]!.bullets.map((b) => b.text)).toEqual([
      "Cut the nightly processing job from 6 hours to 40 minutes",
      "Built a Python pipeline that cleaned three years of sensor data",
    ]);
    expect(existsSync(variant.pdf_path!)).toBe(true);
    expect(variant.parse_check).toMatchObject({ ok: true });

    const fields = Object.fromEntries(d.store.listFieldFills(app.id).map((f) => [f.field_key, f]));
    expect(fields.first_name).toMatchObject({ planned_value: "Alex", source: "profile" });
    expect(fields.question_2).toMatchObject({ planned_value: "No", source: "profile" });
    expect(fields.question_1).toMatchObject({ source: "drafted", flag: null });
    expect(fields.question_3).toMatchObject({ planned_value: null, flag: "red" });
    expect(fields.resume).toMatchObject({ attach: "resume" });
    // The model never saw the known fields, only the open question.
    expect(llm.requests[0]!.user).toContain("Why do you want to work at Example Co?");
    expect(llm.requests[0]!.user).not.toContain("visa sponsorship?");
  });

  it("flags a drafted answer the checker rejects", async () => {
    const llm = new FakeLlm({
      draft: () => draftOutput(),
      truth_check: () => ({
        verdicts: [{ where: "answer:question_1", supported: false, problem: "claims a product" }],
      }),
    });
    const d = deps(llm);
    const posting = makePosting({
      id: "p1",
      questions: QUESTIONS.filter((q) => q.key !== "question_3"),
    });
    d.store.savePostings([posting]);
    const r = await prepareOne(d, posting, "B");
    expect(r.status).toBe("needs_input");
    expect(d.store.listDrafts(r.applicationId)[0]).toMatchObject({
      checker_status: "flagged",
      checker_notes: ["claims a product"],
    });
  });

  it("is Ready when nothing blocks, and works offline with the base resume", async () => {
    const d = deps(null);
    const qs = QUESTIONS.filter((q) => !["question_1", "question_3"].includes(q.key));
    const posting = makePosting({ id: "p1", questions: qs });
    d.store.savePostings([posting]);
    const r = await prepareOne(d, posting, "B");
    expect(r.status).toBe("ready");
    const variant = d.store.getResumeVariant(
      d.store.getApplication(r.applicationId)!.resume_variant_id!,
    )!;
    expect((variant.diff as { summary: unknown }).summary).toEqual({
      kept: 3,
      reworded: 0,
      added: 0,
      removed: 0,
    });
  });

  it("retries an application a failed run left in prepared", async () => {
    const d = deps(new FakeLlm({})); // no handlers: drafting throws
    const posting = makePosting({ id: "p1" });
    d.store.savePostings([posting]);
    await runScoring({ ...d, llm: null });
    expect(await runPrep(d)).toMatchObject({ prepared: 0, failed: 1 });
    expect(d.store.applicationForPosting("p1")?.status).toBe("prepared");
    const offline = { ...d, llm: null };
    expect(await runPrep(offline)).toMatchObject({ prepared: 1, failed: 0 });
    expect(d.store.applicationForPosting("p1")?.status).toBe("ready");
  });

  it("selects by score with a per-company cap", async () => {
    const d = deps(null);
    const postings = [1, 2, 3, 4].map((n) =>
      makePosting({ id: `ex${n}`, title: `Software Engineer Intern ${n}` }),
    );
    postings.push(makePosting({ id: "other", company: "Other Co" }));
    d.store.savePostings(postings);
    await runScoring(d);
    const sel = selectForPrep(d, { limit: 10 });
    expect(sel.filter((s) => s.posting.company === "Example Co")).toHaveLength(3);
    expect(sel.map((s) => s.posting.id)).toContain("other");
    const report = await runPrep(d, { limit: 2 });
    expect(report.prepared).toBe(2);
  });
});

describe("API", () => {
  const TOKEN = "test-token";
  const HOST = "127.0.0.1:4317";

  async function setup() {
    const d = deps(new FakeLlm({ draft: () => draftOutput(), truth_check: passAll }));
    const posting = makePosting({ id: "p1", questions: QUESTIONS });
    d.store.savePostings([posting]);
    const { applicationId } = await prepareOne(d, posting, "A");
    const snapshots = mkdtempSync(join(tmpdir(), "ia-snap-"));
    dirs.push(snapshots);
    const app = buildServer({
      store: d.store,
      profile,
      token: TOKEN,
      outDir: d.outDir,
      snapshotsDir: snapshots,
      uiDir: null,
      allowedHosts: [HOST],
    });
    const call = (
      method: "GET" | "POST" | "PATCH",
      url: string,
      payload?: object,
      headers: Record<string, string> = {},
    ) =>
      app.inject({
        method,
        url,
        ...(payload ? { payload } : {}),
        headers: { host: HOST, "x-ia-token": TOKEN, ...headers },
      });
    return { d, app, call, id: applicationId };
  }

  it("rejects missing tokens, foreign Hosts and foreign origins", async () => {
    const { app, call } = await setup();
    expect((await app.inject({ url: "/api/queue", headers: { host: HOST } })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: "/api/health", headers: { host: "evil.test" } })).statusCode,
    ).toBe(421);
    expect(
      (await call("GET", "/api/queue", undefined, { origin: "https://evil.test" })).statusCode,
    ).toBe(403);
    const ext = await call("GET", "/api/queue", undefined, { origin: "chrome-extension://abc" });
    expect(ext.statusCode).toBe(200);
    expect(ext.headers["access-control-allow-origin"]).toBe("chrome-extension://abc");
  });

  it("walks one application from Needs input to Submitted", async () => {
    const { call, id, d } = await setup();
    const queue = (await call("GET", "/api/queue")).json();
    expect(queue[0]).toMatchObject({ id, status: "needs_input", flags: { red: 1 } });

    expect(
      (await call("POST", `/api/applications/${id}/status`, { to: "approved" })).statusCode,
    ).toBe(409);
    const edit = await call("PATCH", `/api/applications/${id}/fields/question_3`, { value: "No" });
    expect(edit.json()).toEqual({ ok: true, status: "ready" });
    expect(d.store.learnedAnswers().get("do_you_know_anyone_who_works_here")?.answer).toBe("No");

    expect(
      (await call("POST", `/api/applications/${id}/status`, { to: "approved" })).statusCode,
    ).toBe(200);
    expect(
      (await call("POST", `/api/applications/${id}/status`, { to: "filled" })).statusCode,
    ).toBe(400);
    expect(
      (await call("POST", `/api/applications/${id}/submitted`, { detectedBy: "user" })).statusCode,
    ).toBe(409);

    const next = (await call("POST", "/api/session/next", {})).json();
    expect(next).toMatchObject({
      done: false,
      remaining: 1,
      application: { id, applyUrl: expect.stringContaining("greenhouse") },
    });
    expect(
      Buffer.from(next.application.files.resume.base64, "base64").subarray(0, 5).toString(),
    ).toBe("%PDF-");
    expect(next.application.files.resume.name).toBe("Alex_Example_Resume.pdf");

    const filled = (
      await call("POST", `/api/applications/${id}/filled`, {
        seen: { first_name: "Alex", email: "typo@example.com" },
      })
    ).json();
    expect(filled.mismatches).toEqual([
      { key: "email", label: "Email", planned: "alex@example.com", seen: "typo@example.com" },
    ]);

    const sub = await call("POST", `/api/applications/${id}/submitted`, {
      detectedBy: "confirmation_page",
      snapshotHtml: "<html>ok</html>",
    });
    expect(sub.json().application).toMatchObject({ status: "submitted" });
    expect(existsSync(sub.json().application.snapshot_path)).toBe(true);
    expect((await call("GET", "/api/tracker")).json()).toHaveLength(1);
    expect((await call("POST", "/api/session/next", {})).json()).toEqual({
      done: true,
      remaining: 0,
      closed: [],
    });

    const outcome = await call("POST", `/api/applications/${id}/status`, { to: "interview" });
    expect(outcome.json().application.status).toBe("interview");
  });

  it("serves the detail view and the resume PDF", async () => {
    const { call, id } = await setup();
    const detail = (await call("GET", `/api/applications/${id}`)).json();
    expect(detail.resume.diff.summary).toMatchObject({ kept: 3, reworded: 0 });
    expect(detail.fields.length).toBe(QUESTIONS.length);
    const pdf = await call("GET", `/api/applications/${id}/files/resume`);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
  });

  it("only marks submitted from the UI with explicit confirmation", async () => {
    const { call, id } = await setup();
    expect(
      (await call("POST", `/api/applications/${id}/status`, { to: "submitted" })).statusCode,
    ).toBe(400);
  });
});
