import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DraftOutput } from "@ia/ai";
import { FakeLlm } from "@ia/ai";
import type { FormQuestion } from "@ia/core";
import { measureVoice } from "@ia/core";
import { makePosting, testProfile } from "@ia/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { PrepDeps } from "../src/prep.ts";
import { prepareOne } from "../src/prep.ts";
import { memoryStore, routeFetch } from "./helpers.ts";

const profile = testProfile();
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const QUESTIONS: FormQuestion[] = [
  { key: "first_name", label: "First Name", required: true, type: "text" },
  { key: "resume", label: "Resume/CV", required: true, type: "file" },
  {
    key: "question_1",
    label: "Why do you want to work at Example Co?",
    required: true,
    type: "textarea",
  },
];

const CLEAN_ANSWER =
  "I like turning messy data into tools people use, which is what Example Co does.";

function output(bullet: string, answer: string): DraftOutput {
  return {
    resume: {
      entries: [
        {
          entry_id: "exp.lab",
          bullets: [{ text: bullet, fact_ids: ["exp.lab.f1"] }],
        },
      ],
      skills_order: ["python"],
      courses: [],
    },
    answers: [{ question_key: "question_1", text: answer, fact_ids: ["ans.why_field"] }],
    cover_letter: null,
    fit_note: { why: "Python.", gaps: "" },
  };
}

function deps(llm: FakeLlm) {
  const out = mkdtempSync(join(tmpdir(), "ia-out-"));
  dirs.push(out);
  const d: PrepDeps & { store: ReturnType<typeof memoryStore> } = {
    store: memoryStore(),
    profile,
    fetch: routeFetch({}),
    llm,
    outDir: out,
    now: () => new Date("2026-11-17T12:00:00Z"),
  };
  return d;
}

describe("writing rules in prep", () => {
  it("asks for one redraft when the first draft breaks a rule, and keeps the clean one", async () => {
    let n = 0;
    const llm = new FakeLlm({
      draft: () =>
        ++n === 1
          ? output(
              "Leveraged Python to clean three years of sensor data",
              "It's not about the money, it's about the data.",
            )
          : output("Built a Python pipeline that cleaned three years of sensor data", CLEAN_ANSWER),
      truth_check: () => ({ verdicts: [] }),
    });
    const d = deps(llm);
    const posting = makePosting({ id: "p1", questions: QUESTIONS });
    d.store.savePostings([posting]);
    const r = await prepareOne(d, posting, "B");
    const drafts = llm.requests.filter((q) => q.purpose === "draft");
    expect(drafts).toHaveLength(2);
    expect(drafts[0]!.system).toContain("Writing rules for every text you write");
    expect(drafts[1]!.user).toContain("broke these writing rules");
    expect(drafts[1]!.user).toContain("Leveraged");
    expect(r.issues.filter((i) => i.problem.startsWith("writing rule"))).toEqual([]);
    expect(r.status).toBe("ready");
    expect(d.store.events(r.applicationId).map((e) => e.type)).toContain("redraft_for_writing");
  });

  it("flags an answer and reverts a bullet that still break the rules after the redraft", async () => {
    const llm = new FakeLlm({
      draft: () =>
        output(
          "Leveraged Python to clean three years of sensor data",
          "Example Co is a testament to good engineering — I want in.",
        ),
      truth_check: () => ({ verdicts: [] }),
    });
    const d = deps(llm);
    const posting = makePosting({ id: "p2", questions: QUESTIONS });
    d.store.savePostings([posting]);
    const r = await prepareOne(d, posting, "B");
    expect(llm.requests.filter((q) => q.purpose === "draft")).toHaveLength(2); // one redraft only
    expect(r.status).toBe("needs_input");
    const answer = d.store.listDrafts(r.applicationId).find((x) => x.kind === "answer")!;
    expect(answer.checker_status).toBe("flagged");
    expect(answer.checker_notes.join(" ")).toMatch(/testament/);
    expect(answer.checker_notes.join(" ")).toMatch(/dash/);
    const app = d.store.getApplication(r.applicationId)!;
    const variant = d.store.getResumeVariant(app.resume_variant_id!)!;
    const doc = (variant.plan as { doc: { experience: { bullets: { text: string }[] }[] } }).doc;
    expect(doc.experience[0]!.bullets[0]!.text).toBe(
      "Built a Python pipeline that cleaned three years of sensor data",
    );
  });

  it("puts measured voice numbers in the prompt, never sample text", async () => {
    const llm = new FakeLlm({
      draft: () =>
        output("Built a Python pipeline that cleaned three years of sensor data", CLEAN_ANSWER),
      truth_check: () => ({ verdicts: [] }),
    });
    const d = deps(llm);
    const sample =
      "I'd rather ship small things. So I did. It's how I learn best, honestly. ".repeat(30);
    d.voice = measureVoice([sample]);
    const posting = makePosting({ id: "p3", questions: QUESTIONS });
    d.store.savePostings([posting]);
    await prepareOne(d, posting, "B");
    const sys = llm.requests[0]!.system;
    expect(sys).toContain("Measured from the candidate's own writing samples");
    expect(sys).not.toContain("ship small things");
  });
});
