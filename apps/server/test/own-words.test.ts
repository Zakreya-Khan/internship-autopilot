import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DraftOutput } from "@ia/ai";
import { FakeLlm } from "@ia/ai";
import type { FormQuestion, Profile } from "@ia/core";
import { parseCoverLetterBase } from "@ia/core";
import { makePosting, testProfile } from "@ia/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { PrepDeps } from "../src/prep.ts";
import { prepareOne } from "../src/prep.ts";
import { memoryStore, routeFetch } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const QUESTIONS: FormQuestion[] = [
  { key: "first_name", label: "First Name", required: true, type: "text" },
  { key: "resume", label: "Resume/CV", required: true, type: "file" },
  { key: "cover_letter", label: "Cover Letter", required: false, type: "file" },
];

// Fictional letter.
const LETTER = parseCoverLetterBase(`Hello,

I study computer science and I like building tools that people use.

At the lab I built a Python pipeline that cleaned three years of sensor data.

I'd welcome the chance to talk. Thank you for reading.

Sincerely, Alex Example`);

const ADDED =
  "Example Co's data team works on the kind of pipelines I built at the lab, and I'd like to help with that work this summer.";

function output(
  cover: string | null,
  bullet = "Leveraged Python to wrangle sensor data",
): DraftOutput {
  return {
    resume: {
      entries: [
        {
          entry_id: "exp.lab",
          bullets: [
            { text: "Slashed the nightly job runtime", fact_ids: ["exp.lab.f2"] },
            { text: bullet, fact_ids: ["exp.lab.f1"] },
          ],
        },
      ],
      skills_order: ["sql", "python"],
      courses: [],
    },
    answers: [],
    cover_letter: cover === null ? null : [{ text: cover, fact_ids: ["exp.lab.f1"] }],
    fit_note: { why: "Python.", gaps: "" },
  };
}

function deps(llm: FakeLlm, profile: Profile, coverBase = LETTER) {
  const out = mkdtempSync(join(tmpdir(), "ia-out-"));
  dirs.push(out);
  const d: PrepDeps & { store: ReturnType<typeof memoryStore> } = {
    store: memoryStore(),
    profile,
    fetch: routeFetch({}),
    llm,
    outDir: out,
    coverBase,
    now: () => new Date("2026-11-17T12:00:00Z"),
  };
  return d;
}

function ownWordsProfile(): Profile {
  const p = testProfile();
  return { ...p, style: { ...p.style, resume_wording: "original" } };
}

function docOf(d: ReturnType<typeof deps>, appId: number) {
  const app = d.store.getApplication(appId)!;
  const variant = d.store.getResumeVariant(app.resume_variant_id!)!;
  return (variant.plan as { doc: { experience: { id: string; bullets: { text: string }[] }[] } })
    .doc;
}

describe("resume_wording: original", () => {
  it("keeps your bullets word for word, reordered, with no redraft over discarded wording", async () => {
    const llm = new FakeLlm({ draft: () => output(ADDED), truth_check: () => ({ verdicts: [] }) });
    const d = deps(llm, ownWordsProfile());
    const posting = makePosting({ id: "p1", questions: QUESTIONS });
    d.store.savePostings([posting]);
    const r = await prepareOne(d, posting, "A");
    expect(llm.requests.filter((q) => q.purpose === "draft")).toHaveLength(1);
    expect(llm.requests[0]!.system).toContain("Never reword, shorten or merge a bullet");
    const lab = docOf(d, r.applicationId).experience.find((e) => e.id === "exp.lab")!;
    expect(lab.bullets.map((b) => b.text)).toEqual([
      "Cut the nightly processing job from 6 hours to 40 minutes",
      "Built a Python pipeline that cleaned three years of sensor data",
    ]);
    const truth = llm.requests.find((q) => q.purpose === "truth_check")!;
    expect(truth.user).not.toContain("bullet:");
  });
});

describe("cover_letter_base", () => {
  it("sends your letter word for word with one added paragraph before your closing", async () => {
    const llm = new FakeLlm({ draft: () => output(ADDED), truth_check: () => ({ verdicts: [] }) });
    const d = deps(llm, ownWordsProfile());
    const posting = makePosting({ id: "p2", questions: QUESTIONS });
    d.store.savePostings([posting]);
    const r = await prepareOne(d, posting, "A");
    const sys = llm.requests[0]!.system;
    expect(sys).toContain("sent word for word");
    expect(sys).toContain(LETTER.paragraphs[1]!);
    expect(sys).not.toContain("Sincerely, Alex Example");
    expect(sys).toContain("It is not a source of facts");
    const cover = d.store.listDrafts(r.applicationId).find((x) => x.kind === "cover_letter")!;
    expect(cover.text.split("\n\n")).toEqual([
      LETTER.paragraphs[0],
      LETTER.paragraphs[1],
      ADDED,
      LETTER.paragraphs[2],
    ]);
    expect(cover.checker_status).toBe("pass");
    expect(r.status).toBe("ready");
  });

  it("leaves out an added paragraph that breaks a rule, and still sends your letter", async () => {
    const bad = "Example Co is a testament to great engineering — and I want in.";
    const llm = new FakeLlm({ draft: () => output(bad), truth_check: () => ({ verdicts: [] }) });
    const d = deps(llm, ownWordsProfile());
    const posting = makePosting({ id: "p3", questions: QUESTIONS });
    d.store.savePostings([posting]);
    const r = await prepareOne(d, posting, "A");
    expect(llm.requests.filter((q) => q.purpose === "draft")).toHaveLength(2); // one redraft
    const cover = d.store.listDrafts(r.applicationId).find((x) => x.kind === "cover_letter")!;
    expect(cover.text.split("\n\n")).toEqual(LETTER.paragraphs);
    expect(cover.checker_notes.join(" ")).toMatch(/added paragraph left out/);
    expect(r.status).toBe("ready");
  });

  it("leaves out an added paragraph that runs far over the limit", async () => {
    const long = `${"I built a Python pipeline that cleaned three years of sensor data. ".repeat(10)}`;
    const llm = new FakeLlm({ draft: () => output(long), truth_check: () => ({ verdicts: [] }) });
    const d = deps(llm, ownWordsProfile());
    const posting = makePosting({ id: "p4", questions: QUESTIONS });
    d.store.savePostings([posting]);
    const r = await prepareOne(d, posting, "A");
    const cover = d.store.listDrafts(r.applicationId).find((x) => x.kind === "cover_letter")!;
    expect(cover.text.split("\n\n")).toEqual(LETTER.paragraphs);
    expect(cover.checker_notes.join(" ")).toMatch(/limit is 90/);
  });

  it("uses your letter as written when there is no model", async () => {
    const d = deps(null as unknown as FakeLlm, ownWordsProfile());
    d.llm = null;
    const posting = makePosting({ id: "p5", questions: QUESTIONS });
    d.store.savePostings([posting]);
    const r = await prepareOne(d, posting, "A");
    const cover = d.store.listDrafts(r.applicationId).find((x) => x.kind === "cover_letter")!;
    expect(cover.text.split("\n\n")).toEqual(LETTER.paragraphs);
  });
});

describe("cost: nothing to write", () => {
  it("drafts on Haiku when only the bullet order is left to decide", async () => {
    const llm = new FakeLlm({ draft: () => output(null), truth_check: () => ({ verdicts: [] }) });
    const d = deps(llm, ownWordsProfile());
    const posting = makePosting({ id: "p6", questions: QUESTIONS.slice(0, 2) });
    d.store.savePostings([posting]);
    await prepareOne(d, posting, "B");
    expect(llm.requests.find((q) => q.purpose === "draft")!.model).toBe("claude-haiku-5-5");
  });

  it("keeps the usual model when there is a cover letter or a question to write", async () => {
    const llm = new FakeLlm({ draft: () => output(ADDED), truth_check: () => ({ verdicts: [] }) });
    const d = deps(llm, ownWordsProfile());
    const posting = makePosting({ id: "p7", questions: QUESTIONS });
    d.store.savePostings([posting]);
    await prepareOne(d, posting, "A");
    expect(llm.requests.find((q) => q.purpose === "draft")!.model).toBe("claude-opus-5-5");
  });
});
