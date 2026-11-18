import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLlm } from "@ia/ai";
import type { FormQuestion } from "@ia/core";
import { makePosting, testProfile } from "@ia/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/api.ts";
import { syncEmails } from "../src/email-sync.ts";
import { prepareOne } from "../src/prep.ts";
import { memoryStore, routeFetch } from "./helpers.ts";

const profile = testProfile();
const HOST = "127.0.0.1:4317";
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "ia-p3-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const QUESTIONS: FormQuestion[] = [
  { key: "first_name", label: "First Name", required: true, type: "text" },
  {
    key: "q_proud",
    label: "Tell us about a project you're proud of",
    required: false,
    type: "textarea",
  },
];

async function setup(llm: FakeLlm | null = null) {
  const store = memoryStore();
  const out = tmp();
  const companies = ["Example Co", "Other Co", "Third Co"];
  const ids: number[] = [];
  for (const [i, company] of companies.entries()) {
    const posting = makePosting({ id: `p${i}`, company, questions: QUESTIONS });
    store.savePostings([posting]);
    const r = await prepareOne(
      { store, profile, llm: null, fetch: routeFetch({}), outDir: out },
      posting,
      "B",
    );
    ids.push(r.applicationId);
  }
  const app = buildServer({
    store,
    profile,
    token: "t",
    outDir: out,
    snapshotsDir: tmp(),
    uiDir: null,
    allowedHosts: [HOST],
    llm,
  });
  const call = (method: "GET" | "POST", url: string, payload?: object) =>
    app.inject({
      method,
      url,
      ...(payload ? { payload } : {}),
      headers: { host: HOST, "x-ia-token": "t" },
    });
  return { store, app, call, ids };
}

/** Move an application through the real status machine to "submitted". */
function submit(store: ReturnType<typeof memoryStore>, id: number) {
  const s = store.getApplication(id)!.status;
  if (s === "needs_input") store.setFieldByUser(id, "q_proud", "The scheduler.");
  if (store.getApplication(id)!.status !== "ready") store.setStatus(id, "ready");
  store.setStatus(id, "approved");
  store.setStatus(id, "filled");
  store.setStatus(id, "submitted");
}

describe("map-fields", () => {
  it("maps by rules, then by the model for what's left, values only from the plan", async () => {
    const llm = new FakeLlm({
      map_fields: () => ({ matches: [{ page_key: "ia-9", plan_key: "q_proud" }] }),
    });
    const { call, ids, store } = await setup(llm);
    store.setFieldByUser(ids[0]!, "q_proud", "The scheduler.");
    store.setStatus(ids[0]!, "approved");
    const res = await call("POST", `/api/applications/${ids[0]}/map-fields`, {
      fields: [
        { key: "ia-0", label: "Your full name", type: "text", required: true },
        { key: "ia-9", label: "Something you built", type: "textarea", required: false },
        { key: "ia-10", label: "Favourite snack", type: "text", required: false },
      ],
    });
    const by = Object.fromEntries((res.json().fields as { key: string }[]).map((f) => [f.key, f]));
    expect(by["ia-0"]).toMatchObject({ value: "Alex Example", via: "profile_field" });
    expect(by["ia-9"]).toMatchObject({ value: "The scheduler.", via: "model" });
    expect(by["ia-10"]).toMatchObject({ value: null, via: "none" });
    expect(llm.requests[0]!.user).not.toContain("The scheduler.");
  });

  it("refuses applications that aren't approved", async () => {
    const { call, ids } = await setup();
    expect(
      (await call("POST", `/api/applications/${ids[0]}/map-fields`, { fields: [] })).statusCode,
    ).toBe(409);
  });
});

describe("export and stats", () => {
  it("exports every application as CSV and reports outcomes", async () => {
    const { call, store, ids } = await setup();
    submit(store, ids[0]!);
    store.setStatus(ids[0]!, "interview");
    const csv = await call("GET", "/api/export.csv");
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.split("\r\n")[0]).toBe(
      "id,company,title,status,tier,score,ats,locations,submittedAt,nextAction,nextActionDue,contact,appliedUrl",
    );
    expect(csv.body).toContain("interview");
    const tsv = await call("GET", "/api/export.csv?format=tsv");
    expect(tsv.body.split("\r\n")[0]).toContain("\t");
    const stats = (await call("GET", "/api/stats")).json();
    expect(stats.totals.sent).toBe(1);
    expect(stats.byTier[0]).toMatchObject({ key: "B", submitted: 1, positive: 1 });
  });
});

describe("email-sync", () => {
  it("moves statuses forward from a local mbox, and a dry run changes nothing", async () => {
    const { store, ids } = await setup();
    submit(store, ids[0]!);
    submit(store, ids[1]!);
    const dir = tmp();
    const mbox = join(dir, "inbox.mbox");
    writeFileSync(
      mbox,
      [
        "From a Mon Dec 01 10:00:00 2026",
        "From: Example Co <jobs@exampleco.com>",
        "Subject: Next steps",
        "Date: Mon, 01 Dec 2026 10:00:00 +0000",
        "",
        "Please complete the CodeSignal assessment.",
        "From b Tue Dec 02 10:00:00 2026",
        "From: Other Co Talent <talent@other.test>",
        "Subject: Your application to Other Co",
        "Date: Tue, 02 Dec 2026 10:00:00 +0000",
        "",
        "Unfortunately we will not be moving forward.",
        "From c Wed Dec 03 10:00:00 2026",
        "From: Newsletter <news@unrelated.test>",
        "Subject: Weekly digest",
        "",
        "Nothing here.",
        "",
      ].join("\n"),
    );
    const dry = syncEmails(store, mbox, { dryRun: true });
    expect(dry).toMatchObject({ read: 3, matched: 2 });
    expect(store.getApplication(ids[0]!)!.status).toBe("submitted");
    const real = syncEmails(store, mbox);
    expect(real.updated.map((u) => [u.company, u.to])).toEqual([
      ["Example Co", "online_assessment"],
      ["Other Co", "rejected"],
    ]);
    expect(store.getApplication(ids[1]!)!.status).toBe("rejected");
    expect(store.events(ids[1]!).at(-1)).toMatchObject({
      type: "email",
      payload: { subject: "Your application to Other Co" },
    });
  });
});
