import { indexFacts } from "@ia/core";
import { makePosting, testProfile } from "@ia/core/testing";
import { describe, expect, it } from "vitest";
import {
  draftApplication,
  draftSystemPrompt,
  FakeLlm,
  MODELS,
  modelTruthCheck,
  profileForModel,
  sensitiveValues,
} from "../src/index.ts";
import type { DraftOutput } from "../src/index.ts";

const profile = testProfile();
const output: DraftOutput = {
  resume: {
    entries: [
      {
        entry_id: "exp.lab",
        bullets: [{ text: "Built a Python pipeline", fact_ids: ["exp.lab.f1"] }],
      },
    ],
    skills_order: ["python", "typescript"],
    courses: ["databases"],
  },
  answers: [
    { question_key: "why_us", text: "  I like your data tools.  ", fact_ids: [] },
    { question_key: "not_asked", text: "x", fact_ids: [] },
    { question_key: "blank", text: "   ", fact_ids: [] },
  ],
  cover_letter: [{ text: "Paragraph.", fact_ids: ["exp.lab.f1"] }],
  fit_note: { why: "Python data work.", gaps: "No Spark." },
};

describe("draftApplication", () => {
  it("uses Opus with effort by tier and keeps only answers to asked questions", async () => {
    const llm = new FakeLlm({ draft: () => output });
    const qs = [
      { key: "why_us", label: "Why us?", required: true, type: "textarea" as const },
      { key: "blank", label: "Anything else?", required: false, type: "textarea" as const },
    ];
    const a = await draftApplication(llm, {
      profile,
      posting: makePosting(),
      tier: "A",
      openQuestions: qs,
      coverLetter: false,
    });
    expect(llm.requests[0]).toMatchObject({ model: MODELS.opus, effort: "high" });
    expect(a.answers).toEqual([
      { questionKey: "why_us", text: "I like your data tools.", factIds: [] },
    ]);
    expect(a.coverLetter).toBeNull();

    await draftApplication(llm, {
      profile,
      posting: makePosting(),
      tier: "B",
      openQuestions: qs,
      coverLetter: true,
      model: MODELS.sonnet,
    });
    expect(llm.requests[1]).toMatchObject({ model: MODELS.sonnet, effort: "medium" });
  });

  it("keeps the system prompt free of contact, EEO and GPA data, and stable across postings", () => {
    const sys = draftSystemPrompt(profile);
    for (const v of sensitiveValues(profile)) expect(sys).not.toContain(v);
    expect(sys).toContain("exp.lab: facts exp.lab.f1, exp.lab.f2");
    expect(draftSystemPrompt(profile)).toBe(sys); // byte-identical → cacheable
  });
});

describe("modelTruthCheck", () => {
  it("turns unsupported verdicts into blocking issues and ignores unknown items", async () => {
    const llm = new FakeLlm({
      truth_check: () => ({
        verdicts: [
          { where: "a", supported: true, problem: "" },
          { where: "b", supported: false, problem: '"led a team of 5"' },
          { where: "zzz", supported: false, problem: "not an item" },
        ],
      }),
    });
    const issues = await modelTruthCheck(llm, profile, [
      { where: "a", text: "x", factIds: ["exp.lab.f1"], mustCite: true },
      { where: "b", text: "Led a team of 5", factIds: ["exp.lab.f1"], mustCite: true },
    ]);
    expect(issues).toEqual([{ where: "b", problem: '"led a team of 5"', severity: "block" }]);
    expect(llm.requests[0]).toMatchObject({ model: MODELS.opus, effort: "low" });
    expect(llm.requests[0]!.user).toContain("exp.lab.f1 (");
    expect(llm.requests[0]!.user).toContain("): Built a Python pipeline");
  });

  it("shows the checker each fact's role or project, as the drafter sees it", async () => {
    const llm = new FakeLlm({ truth_check: () => ({ verdicts: [] }) });
    await modelTruthCheck(llm, profile, [
      { where: "a", text: "x", factIds: ["exp.lab.f1", "nope"], mustCite: true },
    ]);
    const user = llm.requests[0]!.user;
    const fact = indexFacts(profile).get("exp.lab.f1")!;
    expect(user).toContain(`exp.lab.f1 (${fact.origin}): ${fact.text}`);
    // Tools and verified numbers, exactly as the drafter sees them.
    const drafterLine = profileForModel(profile)
      .split("\n")
      .find((l) => l.startsWith("- exp.lab.f1 "))!;
    expect(user).toContain(drafterLine.slice(2));
    expect(fact.tools.length).toBeGreaterThan(0);
    expect(user).toContain(`[tools: ${fact.tools.join(", ")}]`);
    expect(user).toContain("nope: (unknown id)");
    expect(llm.requests[0]!.system).toMatch(/source is part of the fact/);
    expect(llm.requests[0]!.system).toMatch(/naming a listed tool/);
  });

  it("skips the call when there is nothing to check", async () => {
    const llm = new FakeLlm({});
    expect(await modelTruthCheck(llm, profile, [])).toEqual([]);
    expect(llm.requests).toHaveLength(0);
  });
});
