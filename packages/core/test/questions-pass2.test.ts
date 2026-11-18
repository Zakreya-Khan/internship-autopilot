// Regressions from the second end-to-end pass (real Lever and Greenhouse forms, fictional profile).
import { describe, expect, it } from "vitest";
import type { FormQuestion } from "../src/index.ts";
import {
  buildFillPlan,
  classifyQuestion,
  computeFitScore,
  pickOption,
  rankedMetros,
  WEIGHTS,
} from "../src/index.ts";
import { makePosting, testProfile } from "./fixtures.ts";

const profile = testProfile();
const q = (label: string, extra: Partial<FormQuestion> = {}): FormQuestion => ({
  key: label.toLowerCase().replace(/\W+/g, "_"),
  label,
  required: false,
  type: "text",
  ...extra,
});
const plan = (qs: FormQuestion[]) => buildFillPlan(qs, profile, new Map(), new Map());

describe("pass 2: question handling", () => {
  it("fills Lever's 'Current company' from your current experience entry", () => {
    expect(classifyQuestion(q("Current company"))).toEqual({
      kind: "known",
      field: "current_company",
    });
    expect(plan([q("Current company")])[0]).toMatchObject({
      value: "University research lab",
      source: "profile",
      flag: null,
    });
  });

  it("treats 'If yes, ...' follow-ups as optional, never drafted by the model", () => {
    for (const label of [
      "If yes, can you provide the company with a copy of the agreement?",
      "If you chose 'Referred by an employee', please share their name",
      'If you\'ve selected "Yes", please select the affiliate',
      "If yes, please note your current visa status:",
    ]) {
      expect(classifyQuestion(q(label)).kind).toBe("user_only");
      expect(plan([q(label)])[0]).toMatchObject({ flag: "grey", value: null });
    }
    expect(plan([q("If yes, explain", { required: true })])[0]!.flag).toBe("red");
  });

  it("asks questions about you and this employer at every company, and says why", () => {
    for (const label of [
      "Have you ever been employed by Example Co, or any of its affiliates?",
      "Do you have any relatives, spouses, partners or in-laws currently working for Example Co?",
    ]) {
      const c = classifyQuestion(q(label, { type: "select", options: ["Yes", "No"] }));
      expect(c).toMatchObject({ kind: "needs_you" });
      expect(c.kind === "needs_you" && c.reason).toMatch(/asked at every company/);
    }
  });

  it("matches 'decline' to 'Not Declared' and 'Not Specified' options", () => {
    expect(pickOption(["Female", "Male", "Non-Binary", "Not Declared"], "decline")).toBe(
      "Not Declared",
    );
    expect(pickOption(["Asian", "Not Specified", "White"], "decline")).toBe("Not Specified");
    const gender = q("Please select the gender which most accurately describes how you identify", {
      type: "select",
      options: ["Female", "Male", "Non-Binary", "Not Declared", "Prefer to self-describe:"],
    });
    expect(plan([gender])[0]).toMatchObject({ value: "Not Declared", flag: null });
  });
});

describe("pass 2: location ranking by metro area", () => {
  const prefs = {
    ...profile.preferences,
    locations: ["New York", "NYC", "San Francisco", "Bay Area", "Seattle", "Bellevue"],
  };
  const p = { ...profile, preferences: prefs };
  const loc = (where: string) =>
    computeFitScore(makePosting({ locations: [where] }), p).components.location;

  it("treats places in one metro as one choice, ranked in the order you listed them", () => {
    expect(rankedMetros(prefs.locations)).toEqual(["new york", "bay area", "seattle"]);
    expect(loc("NYC")).toBe(loc("New York, NY"));
    expect(loc("NYC")).toBe(WEIGHTS.location);
    expect(loc("Palo Alto, CA")).toBe(loc("San Francisco, CA"));
    expect(loc("Bellevue, WA")).toBe(loc("Seattle, WA"));
    expect(loc("San Francisco, CA")).toBeGreaterThan(loc("Seattle, WA"));
    expect(loc("Brooklyn, NY")).toBe(WEIGHTS.location);
  });
});
