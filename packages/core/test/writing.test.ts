import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkWriting,
  measureVoice,
  voiceFromSamples,
  voiceNotes,
  voicePrompt,
  writingRulesPrompt,
} from "../src/index.ts";
import { testProfile } from "./fixtures.ts";
import { profileOwnWords } from "../src/writing.ts";

const one = (text: string, own = "") => checkWriting([{ where: "answer:q", text }], own);
const rules = (text: string, own = "") => one(text, own).map((i) => i.rule);

describe("checkWriting: banned words and phrases", () => {
  it("flags stock AI vocabulary, in any case and with curly apostrophes", () => {
    expect(one("I leveraged Python to build it.")[0]).toMatchObject({
      rule: "banned_phrase",
      match: "leveraged",
    });
    expect(rules("I'm passionate about data.")).toEqual(["banned_phrase"]);
    expect(rules("Moreover, the tool was fast.")).toEqual(["banned_phrase"]);
    expect(rules("It’s worth noting the job ran nightly.")).toEqual(["banned_phrase"]);
    expect(rules("We used a cutting edge model.")).toEqual(["banned_phrase"]);
  });

  it("matches whole words only", () => {
    expect(one("Our relevance ranking improved.")).toEqual([]);
    expect(one("I fostered no illusions")).toHaveLength(0); // "fostered" isn't "foster"
    expect(one("Delivery was on time.")).toEqual([]);
  });

  it("reports one hit for overlapping entries", () => {
    expect(one("Leveraging leverage.").filter((i) => i.rule === "banned_phrase")).toHaveLength(1);
  });

  it("allows a word that's already in your own text", () => {
    expect(one("Streamlined the intake form.", "Streamlined the intake form for the lab")).toEqual(
      [],
    );
    const own = profileOwnWords(testProfile());
    expect(own).toContain("Built a Python pipeline");
  });

  it("passes plain writing", () => {
    expect(
      one(
        "I built a Python pipeline that cleaned three years of sensor data. It now runs every night, and I'd like to do similar work on your data team.",
      ),
    ).toEqual([]);
  });
});

describe("checkWriting: dashes", () => {
  it("flags em dashes and their stand-ins", () => {
    expect(rules("I built it — and it worked.")).toEqual(["em_dash"]);
    expect(rules("I built it—fast.")).toEqual(["em_dash"]);
    expect(rules("I built it – and it worked.")).toEqual(["em_dash"]);
    expect(rules("I built it - and it worked.")).toEqual(["em_dash"]);
    expect(rules("I built it -- and it worked.")).toEqual(["em_dash"]);
  });

  it("keeps date and number ranges and ordinary hyphens", () => {
    expect(one("Research assistant, 2025–2026.")).toEqual([]);
    expect(one("From 2025 — present I ran the club.")).toEqual([]);
    expect(one("Cut latency 20–30 ms with a well-known cache.")).toEqual([]);
    expect(one("A conflict-free schedule.")).toEqual([]);
  });
});

describe("checkWriting: reframe constructions", () => {
  const reframes = [
    "It's not about the code, it's about the people.",
    "This isn't a side project. It's a product.",
    "Not only did I build it, but I also shipped it.",
    "I see it not as a job, but as a chance to learn.",
    "The role isn't just a job to me.",
    "Less talk, more shipping.",
    "No meetings, no slides, just code.",
    "Is it hard? No. It takes practice.",
  ];
  for (const text of reframes)
    it(`flags: ${text}`, () => {
      expect(rules(text)).toContain("reframe");
    });

  it("leaves ordinary negatives alone", () => {
    for (const text of [
      "Python is not my strongest language yet, so I took a course.",
      "I did not have a mentor, so I read the docs.",
      "The job ran nightly. It took 40 minutes.",
      "I want to learn more about compilers.",
    ])
      expect(rules(text)).toEqual([]);
  });
});

describe("writingRulesPrompt", () => {
  it("lists the rules for the model", () => {
    const p = writingRulesPrompt();
    expect(p).toContain("leverage");
    expect(p).toContain("No em dashes");
    expect(p).toContain("not X but Y");
  });
});

describe("voice traits", () => {
  const sample = `Hi all,

I built the club's website last spring. It wasn't fancy, but it worked. And people used it! I'd do a few things differently now (mostly the CSS).

So here's what I learned. Small tools beat big plans. I'm still proud of the sign-up form, honestly. Would I rebuild it? Probably.`;

  it("measures numbers only", () => {
    const t = measureVoice([sample]);
    expect(t.totalWords).toBeGreaterThan(40);
    expect(t.meanSentenceWords).toBeGreaterThan(3);
    expect(t.contractionsPer100).toBeGreaterThan(5);
    expect(t.firstPersonPer100).toBeGreaterThan(5);
    expect(t.questionsPer100Sentences).toBeGreaterThan(0);
    expect(t.conjunctionOpenersPct).toBeGreaterThan(0);
    expect(t.enough).toBe(false);
    // Nothing but numbers and flags: no text from the sample survives.
    for (const v of Object.values(t)) expect(["number", "boolean"]).toContain(typeof v);
  });

  it("turns traits into guidance without quoting the samples", () => {
    const t = measureVoice([sample.repeat(8)]);
    expect(t.enough).toBe(true);
    const p = voicePrompt(t);
    expect(p).toContain("Sentences average about");
    expect(p).toContain("resume bullets stay plain");
    expect(p).not.toContain("club");
    expect(p).not.toContain("sign-up");
    expect(voicePrompt(null)).toContain("Conversational");
  });

  it("notes a draft far wordier than your own writing", () => {
    const t = measureVoice([sample.repeat(8)]);
    const wordy =
      "In my most recent role at the university research laboratory I was responsible for building and maintaining a large data processing pipeline that handled many years of sensor readings from instruments across campus. ".repeat(
        4,
      );
    expect(voiceNotes(t, wordy)[0]).toMatch(/^voice: sentences average/);
    expect(voiceNotes(t, sample.repeat(8))).toEqual([]);
  });

  it("reads .txt and .md samples from a folder next to the profile", () => {
    const dir = mkdtempSync(join(tmpdir(), "ia-voice-"));
    try {
      mkdirSync(join(dir, "samples"));
      writeFileSync(join(dir, "samples", "a.txt"), sample);
      writeFileSync(join(dir, "samples", "b.md"), `# Title\n\n${sample}`);
      writeFileSync(join(dir, "samples", "README.md"), "ignored ".repeat(500));
      writeFileSync(join(dir, "samples", "c.pdf"), "ignored");
      const t = voiceFromSamples(["samples", "missing.txt"], join(dir, "profile.yaml"));
      expect(t?.sampleCount).toBe(2);
      expect(voiceFromSamples([], join(dir, "profile.yaml"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
