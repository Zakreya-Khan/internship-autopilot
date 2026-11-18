// The questions inbox and learned-answer bank. Fictional companies, questions and answers.
import { FakeLlm } from "@ia/ai";
import type { FillEntry, FormQuestion } from "@ia/core";
import { makePosting, testProfile } from "@ia/core/testing";
import { describe, expect, it } from "vitest";
import {
  answerQuestion,
  applyAnswerToPending,
  backfillPending,
  questionsInbox,
  resolveQuestion,
  settleSuggestion,
} from "../src/answers.ts";
import { buildServer } from "../src/api.ts";
import { memoryStore } from "./helpers.ts";

const profile = testProfile();

function field(label: string, over: Partial<FillEntry> = {}): FillEntry {
  return {
    key: label.toLowerCase().replace(/\W+/g, "_").slice(0, 40),
    label,
    type: "text",
    required: true,
    value: null,
    source: "you",
    confidence: "low",
    flag: "red",
    note: "Needs you: not recognized.",
    ...over,
  };
}
const filled = (label: string): FillEntry =>
  field(label, { value: "Alex", source: "profile", confidence: "high", flag: null, note: null });

/** One application per company, in Needs input, with these fields. */
function seed(apps: { company: string; fields: FillEntry[] }[]) {
  const store = memoryStore();
  const ids: number[] = [];
  apps.forEach((a, i) => {
    const p = makePosting({ id: `p${i}`, company: a.company, title: "Software Engineer Intern" });
    store.savePostings([p]);
    const app = store.createApplication(p.id, "A");
    store.replaceFieldFills(app.id, [filled("First Name"), ...a.fields]);
    store.setStatus(app.id, "needs_input");
    ids.push(app.id);
  });
  return { store, ids };
}

const RELOCATE = "Are you willing to relocate for this internship?";
const YES_NO = { type: "select" as const, options: ["Yes", "No"] };
const items = (store: ReturnType<typeof memoryStore>, groupIndex = 0) =>
  questionsInbox(store)[groupIndex]!.items.map((i) => ({
    applicationId: i.applicationId,
    fieldKey: i.fieldKey,
  }));

describe("questions inbox", () => {
  it("groups one question across applications, with the companies that ask it", () => {
    const { store } = seed([
      { company: "Alpha Co", fields: [field(RELOCATE, YES_NO)] },
      { company: "Beta Co", fields: [field("Would you be open to relocation?", YES_NO)] },
      { company: "Gamma Co", fields: [field("Do you have a security clearance?")] },
    ]);
    const groups = questionsInbox(store);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      question: RELOCATE,
      wordings: ["Would you be open to relocation?"],
      companies: ["Alpha Co", "Beta Co"],
      options: ["Yes", "No"],
      companySpecific: false,
      sensitive: false,
      defaultScope: "always",
    });
    expect(groups[0]!.items).toHaveLength(2);
  });

  it("keeps company-specific questions apart per company and marks sensitive ones", () => {
    const { store } = seed([
      { company: "Alpha Co", fields: [field("Have you ever been employed by Alpha Co?", YES_NO)] },
      { company: "Beta Co", fields: [field("Have you ever been employed by Beta Co?", YES_NO)] },
      { company: "Gamma Co", fields: [field("What is your cumulative GPA?")] },
    ]);
    const groups = questionsInbox(store);
    expect(groups).toHaveLength(3);
    expect(groups.filter((g) => g.companySpecific).map((g) => g.defaultScope)).toEqual([
      "company",
      "company",
    ]);
    expect(groups.find((g) => g.sensitive)).toMatchObject({ defaultScope: "once" });
  });

  it("leaves out answered, optional, file and submitted fields", () => {
    const { store, ids } = seed([
      {
        company: "Alpha Co",
        fields: [
          field("Optional note", { required: false, flag: "amber" }),
          field("Portfolio upload", { type: "file" }),
        ],
      },
      { company: "Beta Co", fields: [field(RELOCATE, YES_NO)] },
    ]);
    for (const to of ["ready", "approved", "filled", "submitted"] as const) {
      if (to === "ready") store.replaceFieldFills(ids[1]!, [filled("First Name")]);
      store.db.prepare("UPDATE applications SET status = ? WHERE id = ?").run(to, ids[1]!);
    }
    expect(questionsInbox(store)).toEqual([]);
    expect(questionsInbox(store, { includeOptional: true }).map((g) => g.question)).toEqual([
      "Optional note",
    ]);
  });
});

describe("answering", () => {
  it("answers once for every application, makes them ready, and fills the same question later", async () => {
    const { store, ids } = seed([
      { company: "Alpha Co", fields: [field(RELOCATE, YES_NO)] },
      {
        company: "Beta Co",
        fields: [field(RELOCATE, { ...YES_NO, options: ["Yes", "No", "Maybe"] })],
      },
    ]);
    const r = await answerQuestion(store, null, items(store), "Yes", "always");
    expect(r).toMatchObject({ filled: 2, scope: "always", saved: [expect.any(Number)] });
    expect(r.touched.sort()).toEqual(ids.sort());
    expect(ids.map((id) => store.getApplication(id)!.status)).toEqual(["ready", "ready"]);
    expect(questionsInbox(store)).toEqual([]);
    expect(store.learnedBankDetails()[0]).toMatchObject({
      answer: "Yes",
      scope: "always",
      uses: 2,
    });

    // A new application asking the same question is filled straight from the bank.
    const later = await resolveQuestion(
      store,
      { key: "x", label: RELOCATE, type: "select", options: ["Yes", "No"] },
      "Delta Co",
      null,
    );
    expect(later).toMatchObject({ kind: "fill", value: "Yes" });
  });

  it("fills other pending applications asking the same thing (backfill)", async () => {
    const { store, ids } = seed([
      { company: "Alpha Co", fields: [field(RELOCATE, YES_NO)] },
      { company: "Beta Co", fields: [field("Do you have a security clearance?")] },
      { company: "Gamma Co", fields: [field("Do you have a security clearance?")] },
    ]);
    // Answer only Beta's, from its own page: Gamma is filled too.
    const r = await answerQuestion(
      store,
      null,
      [{ applicationId: ids[1]!, fieldKey: "do_you_have_a_security_clearance_" }],
      "No",
      "always",
    );
    expect(r.backfill).toMatchObject({ filled: 1, applications: [ids[2]] });
    expect(store.getApplication(ids[2]!)!.status).toBe("ready");
    expect(store.getApplication(ids[0]!)!.status).toBe("needs_input");
  });

  it("keeps company-only answers at their company, and never reuses across companies", async () => {
    const { store, ids } = seed([
      { company: "Alpha Co", fields: [field("Have you ever been employed by Alpha Co?", YES_NO)] },
      { company: "Beta Co", fields: [field("Have you ever been employed by Beta Co?", YES_NO)] },
    ]);
    const alpha = questionsInbox(store).find((g) => g.companies[0] === "Alpha Co")!;
    const r = await answerQuestion(
      store,
      null,
      alpha.items.map((i) => ({ applicationId: i.applicationId, fieldKey: i.fieldKey })),
      "No",
      "always", // asked for always: a question about one employer is kept to that employer
    );
    expect(r.scope).toBe("company");
    expect(r.backfill.filled).toBe(0);
    expect(store.getApplication(ids[1]!)!.status).toBe("needs_input");
    expect(store.learnedBank()[0]).toMatchObject({ scope: "company", company: "Alpha Co" });
  });

  it("'just this once' fills without saving; sensitive answers are never saved", async () => {
    const { store, ids } = seed([
      { company: "Alpha Co", fields: [field("Do you have a security clearance?")] },
      { company: "Beta Co", fields: [field("Will you require visa sponsorship?", YES_NO)] },
    ]);
    await answerQuestion(
      store,
      null,
      [{ applicationId: ids[0]!, fieldKey: "do_you_have_a_security_clearance_" }],
      "No",
      "once",
    );
    const sponsor = questionsInbox(store).find((g) => g.sensitive)!;
    const r = await answerQuestion(
      store,
      null,
      sponsor.items.map((i) => ({ applicationId: i.applicationId, fieldKey: i.fieldKey })),
      "No",
      "always",
    );
    expect(r.scope).toBe("once");
    expect(store.learnedBank()).toEqual([]);
    expect(ids.map((id) => store.getApplication(id)!.status)).toEqual(["ready", "ready"]);
  });

  it("maps your answer onto each form's own options, and leaves a suggestion where it can't", async () => {
    const { store, ids } = seed([
      {
        company: "Alpha Co",
        fields: [
          field("When can you start?", { type: "select", options: ["May 2027", "June 2027"] }),
        ],
      },
      {
        company: "Beta Co",
        fields: [field("When can you start?", { type: "select", options: ["Summer", "Fall"] })],
      },
    ]);
    const r = await answerQuestion(store, null, items(store), "June 2027", "always");
    expect(r.filled).toBe(1);
    expect(r.unmapped).toEqual([{ applicationId: ids[1], fieldKey: "when_can_you_start_" }]);
    const beta = store.listFieldFills(ids[1]!).find((f) => f.field_key === "when_can_you_start_")!;
    expect(beta).toMatchObject({
      planned_value: null,
      suggestion: { value: "June 2027", mapped: false },
    });
    await expect(
      settleSuggestion(store, null, ids[1]!, "when_can_you_start_", true),
    ).rejects.toThrow(/pick one/);
    await settleSuggestion(store, null, ids[1]!, "when_can_you_start_", true, "Summer");
    expect(store.getApplication(ids[1]!)!.status).toBe("ready");
  });
});

describe("similar questions", () => {
  async function bankWith(answer: string, question: string) {
    const s = seed([
      { company: "Alpha Co", fields: [field(question)] },
      { company: "Beta Co", fields: [field("What is your earliest start date?")] },
    ]);
    await answerQuestion(
      s.store,
      null,
      [{ applicationId: s.ids[0]!, fieldKey: field(question).key }],
      answer,
      "always",
    );
    return s;
  }

  it("offers a borderline match as a suggestion, checked by the model with only the two questions", async () => {
    const { store, ids } = await bankWith("June 1, 2027", "When are you available to start?");
    // Without a model it's still offered, as a suggestion.
    const beta = () => store.listFieldFills(ids[1]!).find((f) => f.label.startsWith("What is"))!;
    expect(beta()).toMatchObject({
      planned_value: null,
      flag: "red",
      suggestion: { value: "June 1, 2027", from: "When are you available to start?" },
    });
    expect(store.getApplication(ids[1]!)!.status).toBe("needs_input");

    // The model's check sees the two questions only, never the answer.
    store.setSuggestion(ids[1]!, beta().field_key, null);
    const llm = new FakeLlm({ question_match: () => ({ same: false }) });
    expect(await backfillPending(store, llm)).toMatchObject({ suggested: 0 });
    const req = llm.requests[0]!;
    expect(req).toMatchObject({ purpose: "question_match", model: "claude-haiku-5-5" });
    expect(req.user).toContain("When are you available to start?");
    expect(req.user).toContain("What is your earliest start date?");
    expect(`${req.system}${req.user}`).not.toContain("June 1, 2027");
    // The verdict is cached: no second call.
    await backfillPending(store, llm);
    expect(llm.requests).toHaveLength(1);
  });

  it("remembers a confirmed match as an alias, and a rejected one so it isn't offered again", async () => {
    const { store, ids } = await bankWith("June 1, 2027", "When are you available to start?");
    const key = store.listFieldFills(ids[1]!).find((f) => f.label.startsWith("What is"))!.field_key;
    await settleSuggestion(store, null, ids[1]!, key, true);
    expect(store.getApplication(ids[1]!)!.status).toBe("ready");
    expect(store.learnedBank()[0]!.aliases).toEqual([
      { key: "what_is_your_earliest_start_date", text: "What is your earliest start date?" },
    ]);
    // Next time the same wording is an exact match.
    expect(
      await resolveQuestion(
        store,
        { key: "q", label: "What is your earliest start date?", type: "text" },
        "Delta Co",
        null,
      ),
    ).toMatchObject({ kind: "fill", value: "June 1, 2027" });

    const other = await bankWith("June 1, 2027", "When are you available to start?");
    const k2 = other.store
      .listFieldFills(other.ids[1]!)
      .find((f) => f.label.startsWith("What is"))!.field_key;
    await settleSuggestion(other.store, null, other.ids[1]!, k2, false);
    expect(await backfillPending(other.store, null)).toMatchObject({ suggested: 0, filled: 0 });
  });
});

describe("answer bank", () => {
  it("edits an answer and updates pending (never submitted) applications that used it", async () => {
    const { store, ids } = seed([
      { company: "Alpha Co", fields: [field("Do you have a security clearance?")] },
      { company: "Beta Co", fields: [field("Do you have a security clearance?")] },
    ]);
    await answerQuestion(store, null, items(store), "No", "always");
    const id = store.learnedBank()[0]!.id;
    store.db.prepare("UPDATE applications SET status = 'submitted' WHERE id = ?").run(ids[1]!);
    store.updateLearned(id, { answer: "No, but eligible" });
    expect(applyAnswerToPending(store, id)).toMatchObject({ updated: 1 });
    const value = (i: number) =>
      store.listFieldFills(ids[i]!).find((f) => f.label.startsWith("Do you"))!.planned_value;
    expect(value(0)).toBe("No, but eligible");
    expect(value(1)).toBe("No"); // submitted: untouched
  });

  it("is reachable over the API, and deleting keeps filled values", async () => {
    const { store, ids } = seed([{ company: "Alpha Co", fields: [field(RELOCATE, YES_NO)] }]);
    const app = buildServer({
      store,
      profile,
      token: "t".repeat(32),
      outDir: "/nonexistent",
      snapshotsDir: "/nonexistent",
      uiDir: null,
      allowedHosts: ["127.0.0.1:4317"],
    });
    const call = (method: string, url: string, payload?: object) =>
      app.inject({
        method: method as "GET",
        url,
        ...(payload ? { payload } : {}),
        headers: { host: "127.0.0.1:4317", "x-ia-token": "t".repeat(32) },
      });
    expect((await call("GET", "/api/questions/count")).json()).toEqual({ count: 1 });
    const inbox = (await call("GET", "/api/questions")).json() as {
      groups: { items: { applicationId: number; fieldKey: string }[] }[];
    };
    const answered = await call("POST", "/api/questions/answer", {
      items: inbox.groups[0]!.items.map((i) => ({
        applicationId: i.applicationId,
        fieldKey: i.fieldKey,
      })),
      answer: "Yes",
      scope: "always",
    });
    expect(answered.json()).toMatchObject({ filled: 1, touched: [ids[0]] });
    expect(
      (await call("POST", "/api/questions/answer", { items: [], answer: "x" })).statusCode,
    ).toBe(400);
    const bank = (await call("GET", "/api/answers")).json() as {
      id: number;
      uses: number;
      pending: number;
    }[];
    expect(bank[0]).toMatchObject({ uses: 1, pending: 1 });
    expect((await call("PATCH", `/api/answers/${bank[0]!.id}`, { answer: "" })).statusCode).toBe(
      400,
    );
    expect((await call("DELETE", `/api/answers/${bank[0]!.id}`)).statusCode).toBe(200);
    expect((await call("GET", "/api/answers")).json()).toEqual([]);
    expect(store.listFieldFills(ids[0]!).find((f) => f.label === RELOCATE)!.planned_value).toBe(
      "Yes",
    );
  });
});

describe("prep with the bank", () => {
  it("doesn't draft a question your answers already fill", async () => {
    const { prepInputs } = await import("../src/prep.ts");
    const store = memoryStore();
    const questions: FormQuestion[] = [
      {
        key: "q1",
        label: "Tell us about a project you are proud of.",
        required: true,
        type: "textarea",
      },
    ];
    const p = makePosting({ id: "p1", company: "Alpha Co", questions });
    store.savePostings([p]);
    store.saveLearnedAnswer({
      questionKey: "tell_us_about_a_project_you_are_proud_of",
      question: "Tell us about a project you are proud of.",
      answer: "My own words about a project.",
      scope: "always",
      company: "",
    });
    const i = prepInputs(
      { store, profile, fetch: async () => new Response(""), llm: null, outDir: "/x" },
      p,
      "A",
    );
    expect(i.openToDraft).toEqual([]);
  });
});
