// Matching a new form's question to one you answered before. Fictional questions and companies.
import { describe, expect, it } from "vitest";
import type { FormQuestion, LearnedAnswer } from "../src/index.ts";
import {
  AUTO_MATCH,
  buildFillPlan,
  defaultScope,
  findLearnedAnswer,
  isCompanySpecific,
  isSensitiveQuestion,
  questionKey,
  questionSimilarity,
  SUGGEST_MATCH,
} from "../src/index.ts";
import { testProfile } from "./fixtures.ts";

const q = (label: string, extra: Partial<FormQuestion> = {}): FormQuestion => ({
  key: questionKey(label),
  label,
  required: true,
  type: "text",
  ...extra,
});
const learned = (
  id: number,
  question: string,
  answer: string,
  over: Partial<LearnedAnswer> = {},
): LearnedAnswer => ({
  id,
  questionKey: questionKey(question),
  question,
  answer,
  scope: "always",
  company: "",
  aliases: [],
  ...over,
});

describe("similarity", () => {
  it("scores reworded relocation, on-site, commute, start and availability questions as alike", () => {
    const alike: [string, string][] = [
      ["Are you willing to relocate for this internship?", "Would you be open to relocation?"],
      [
        "Please confirm you are willing to be on-site for the duration of the internship.",
        "Are you able to work on-site in our office for the entire internship?",
      ],
      [
        "Are you able to commute in for a hybrid work schedule?",
        "Can you commute to our office for a hybrid schedule?",
      ],
      ["When are you available to start?", "What is your earliest start date?"],
      [
        "Are you available for a 12 week internship this summer?",
        "Can you commit to the full 12-week summer program?",
      ],
    ];
    for (const [a, b] of alike)
      expect(questionSimilarity(a, b)).toBeGreaterThanOrEqual(SUGGEST_MATCH);
    expect(
      questionSimilarity("Are you willing to relocate?", "Would you be open to relocation?"),
    ).toBeGreaterThanOrEqual(AUTO_MATCH);
  });

  it("scores different questions as different", () => {
    expect(
      questionSimilarity("Are you willing to relocate?", "Do you have a security clearance?"),
    ).toBe(0);
    expect(
      questionSimilarity("Are you willing to relocate?", "Why do you want to work here?"),
    ).toBe(0);
    // Found live: "ever employed by X" scored 0.55 against "relatives employed at X".
    expect(
      questionSimilarity(
        "Have you ever been employed by Example Co, or any of its affiliates?",
        "Do you have any relatives or in-laws currently employed at Example Co?",
        "Example Co",
        "Example Co",
      ),
    ).toBe(0);
    expect(
      questionSimilarity(
        "Do you have any outstanding offers or deadlines?",
        "Are you holding any outstanding offers?",
      ),
    ).toBeGreaterThanOrEqual(SUGGEST_MATCH);
    expect(
      questionSimilarity(
        "Are you willing to relocate to Springfield?",
        "Are you willing to relocate to Shelbyville?",
      ),
    ).toBeLessThan(AUTO_MATCH);
  });
});

describe("company-specific and sensitive questions", () => {
  it("knows questions about you and one employer", () => {
    expect(isCompanySpecific("Why do you want to work at Example Co?", "Example Co")).toBe(true);
    expect(isCompanySpecific("Have you ever been employed by Example Co?", "Example Co")).toBe(
      true,
    );
    expect(isCompanySpecific("Do you have relatives working at Example Co?", "Example Co")).toBe(
      true,
    );
    expect(isCompanySpecific("Are you bound by a non-compete agreement?", "Example Co")).toBe(true);
    expect(isCompanySpecific("What excites you about Example Co's mission?", "Example Co")).toBe(
      true,
    );
    expect(isCompanySpecific("Are you willing to relocate?", "Example Co")).toBe(false);
    // Companies often drop an industry word from their own name.
    expect(
      isCompanySpecific("How did you first hear about Ring Works?", "Ring Works Capital"),
    ).toBe(true);
    expect(isCompanySpecific("Which team at Orbitex interests you?", "Orbitex Space")).toBe(true);
    expect(isCompanySpecific("Do you follow the capital markets?", "Ring Works Capital")).toBe(
      false,
    );
    expect(defaultScope("Have you ever worked at Example Co?", "Example Co")).toBe("company");
    expect(defaultScope("Are you willing to relocate?", "Example Co")).toBe("always");
  });

  it("treats EEO, work authorization, GPA and contact questions as sensitive", () => {
    for (const label of [
      "Will you now or in the future require visa sponsorship?",
      "Are you legally authorized to work in the United States?",
      "Please indicate your current Immigration and Work Authorization status (export control).",
      "What is your cumulative GPA?",
      "Gender",
      "Veteran status",
      "Phone number",
      "Legal Address:",
    ])
      expect(isSensitiveQuestion(q(label))).toBe(true);
    expect(isSensitiveQuestion(q("Are you willing to relocate?"))).toBe(false);
  });
});

describe("findLearnedAnswer", () => {
  const bank = [
    learned(1, "Are you willing to relocate for this internship?", "Yes"),
    learned(2, "Have you ever been employed by Example Co?", "No", {
      scope: "company",
      company: "Example Co",
    }),
    learned(3, "When are you available to start?", "June 1, 2027"),
    learned(4, "Do you have a security clearance?", "No", {
      aliases: [
        { key: "do_you_hold_an_active_clearance", text: "Do you hold an active clearance?" },
      ],
    }),
  ];

  it("(a) matches the exact wording, or a wording you confirmed", () => {
    expect(
      findLearnedAnswer(q("Are you willing to relocate for this internship?"), "Other Co", bank),
    ).toMatchObject({
      how: "exact",
      answer: { id: 1 },
    });
    expect(
      findLearnedAnswer(q("Do you hold an active clearance?"), "Other Co", bank),
    ).toMatchObject({
      how: "exact",
      answer: { id: 4 },
    });
  });

  it("(b) finds reworded questions by similarity", () => {
    const relocation = findLearnedAnswer(q("Would you be open to relocation?"), "Other Co", bank);
    expect(relocation).toMatchObject({ how: "similar", answer: { id: 1 } });
    expect(relocation!.score).toBeGreaterThanOrEqual(AUTO_MATCH);
    const start = findLearnedAnswer(q("What is your earliest start date?"), "Other Co", bank);
    expect(start).toMatchObject({ how: "similar", answer: { id: 3 } });
    expect(start!.score).toBeLessThan(AUTO_MATCH); // a suggestion, not an automatic fill
  });

  it("never carries a company-specific answer to another company", () => {
    expect(
      findLearnedAnswer(q("Have you ever been employed by Example Co?"), "Example Co", bank),
    ).toMatchObject({
      answer: { id: 2 },
    });
    expect(
      findLearnedAnswer(q("Have you ever been employed by Other Co?"), "Other Co", bank),
    ).toBeNull();
    // Even an "always" answer to a company-specific question stays at its company.
    const loose = [learned(9, "Have you ever worked here before?", "No")];
    expect(findLearnedAnswer(q("Have you ever worked here before?"), "Other Co", loose)).toBeNull();
  });

  it("never matches a sensitive question, and skips answers you rejected", () => {
    const withSponsor = [...bank, learned(5, "Do you need visa sponsorship?", "No")];
    expect(
      findLearnedAnswer(q("Do you need visa sponsorship?"), "Other Co", withSponsor),
    ).toBeNull();
    expect(
      findLearnedAnswer(q("Would you be open to relocation?"), "Other Co", bank, new Set([1])),
    ).toBeNull();
  });
});

describe("fill plan with the bank", () => {
  const profile = testProfile();
  it("fills from a learned hit and only offers a suggestion beside a field still waiting for you", () => {
    const qs = [
      q("Are you willing to commute to the office three days a week?", {
        type: "select",
        options: ["Yes", "No"],
      }),
      q("Do you have a security clearance?"),
    ];
    const plan = buildFillPlan(qs, profile, new Map(), (x) =>
      x.label.startsWith("Are you willing")
        ? { kind: "fill", value: "Yes", answerId: 7 }
        : {
            kind: "suggest",
            value: "No",
            answerId: 4,
            from: "Do you hold an active clearance?",
            score: 0.6,
            mapped: true,
          },
    );
    expect(plan[0]).toMatchObject({ value: "Yes", source: "you", answerId: 7, flag: null });
    expect(plan[1]).toMatchObject({
      value: null,
      flag: "red",
      suggestion: { value: "No", answerId: 4, from: "Do you hold an active clearance?" },
    });
  });
});
