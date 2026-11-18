import { describe, expect, it } from "vitest";
import {
  acceptedDegrees,
  evaluateQualification,
  experienceMonths,
  minimumExperienceMonths,
  minimumGpa,
  requirementLines,
} from "../src/qualify.ts";
import type { RequirementMatch } from "../src/scoring.ts";
import { makePosting, testProfile } from "./fixtures.ts";

const NOW = new Date("2026-11-18T00:00:00Z");
const profile = testProfile(); // GPA 3.70, bachelors, graduating 2028-05, one job since 2026-01

const posting = (description: string, over = {}) =>
  makePosting({ descriptionText: description, degrees: [], ...over });

describe("requirementLines", () => {
  const text = [
    "About us",
    "We have 10 years of experience helping teams ship.",
    "Minimum Qualifications",
    "Currently pursuing a Bachelor's degree",
    "Minimum GPA of 3.0",
    "Preferred Qualifications",
    "2+ years of experience with Kubernetes",
    "Experience with Go is a plus",
    "Benefits",
    "You'll get free lunch",
  ].join("\n");

  it("keeps lines under a required heading and drops preferred ones", () => {
    const lines = requirementLines(text);
    expect(lines).toContain("Minimum GPA of 3.0");
    expect(lines).toContain("Currently pursuing a Bachelor's degree");
    expect(lines.join("\n")).not.toMatch(/Kubernetes|Go is a plus/);
  });

  it("ignores company boilerplate that isn't phrased as a requirement", () => {
    expect(requirementLines(text).join("\n")).not.toMatch(/helping teams/);
  });

  it("counts a requirement-style line even with no headings", () => {
    expect(requirementLines("You must have at least 1 year of experience in Python.")).toHaveLength(
      1,
    );
  });
});

describe("what a posting asks for", () => {
  it("reads a minimum GPA only when it is stated as a minimum", () => {
    expect(minimumGpa(["Minimum GPA of 3.2"])).toBe(3.2);
    expect(minimumGpa(["3.5+ GPA"])).toBe(3.5);
    expect(minimumGpa(["GPA of 3.0 or higher on a 4.0 scale"])).toBe(3.0);
    expect(minimumGpa(["Our interns average a 3.9 GPA"])).toBeNull();
    expect(minimumGpa(["Strong academic record"])).toBeNull();
  });

  it("reads years and months of experience, taking the largest", () => {
    expect(minimumExperienceMonths(["2+ years of professional experience"])).toBe(24);
    expect(minimumExperienceMonths(["at least 6 months of relevant work experience"])).toBe(6);
    expect(
      minimumExperienceMonths(["1 year of Python experience", "3 years of industry experience"]),
    ).toBe(36);
    expect(minimumExperienceMonths(["Experience with Python"])).toBeNull();
  });

  it("reads degree levels from 'pursuing' lines and the structured list", () => {
    const p = posting("x", { degrees: ["Bachelor's"] });
    expect(
      acceptedDegrees(p, ["Currently pursuing a Master's or PhD in Computer Science"]),
    ).toEqual(["Bachelor's", "master", "phd"]);
    expect(acceptedDegrees(p, ["Our PhD scientists mentor you"])).toEqual(["Bachelor's"]);
  });
});

describe("experienceMonths", () => {
  it("counts jobs once even when they overlap, and ignores projects", () => {
    const p = testProfile((x) => ({
      ...x,
      experience: [
        { ...x.experience[0]!, start: "2025-06", end: "2025-12" },
        { ...x.experience[0]!, id: "exp.two", start: "2025-09", end: "2026-03" },
      ],
    }));
    expect(experienceMonths(p, NOW)).toBe(9);
  });

  it("counts a current job up to now", () => {
    expect(experienceMonths(profile, NOW)).toBe(10); // 2026-01 to 2026-11
  });
});

describe("evaluateQualification", () => {
  const model = (required: string[], matched: string[]): RequirementMatch => ({
    required,
    matched,
    missing: required.filter((r) => !matched.includes(r)),
    method: "model",
  });

  it("meets when every stated minimum is met, with at least two stated", () => {
    const q = evaluateQualification(
      posting("Minimum Qualifications\nMinimum GPA of 3.0\nCurrently pursuing a Bachelor's degree"),
      profile,
      null,
      NOW,
    );
    expect(q.verdict).toBe("meets");
    expect(q.checks.map((c) => c.kind).sort()).toEqual(["degree", "gpa"]);
  });

  it("is close when exactly one minimum is not met, and says which", () => {
    const q = evaluateQualification(
      posting("Minimum Qualifications\nMinimum GPA of 3.9\nCurrently pursuing a Bachelor's degree"),
      profile,
      null,
      NOW,
    );
    expect(q.verdict).toBe("close");
    const gap = q.checks.find((c) => c.met === false)!;
    expect(gap).toMatchObject({ kind: "gpa", need: "GPA of 3.9 or higher", have: "GPA 3.70" });
  });

  it("is short when two or more are not met", () => {
    const q = evaluateQualification(
      posting("Minimum Qualifications\nMinimum GPA of 3.9\n3+ years of professional experience"),
      profile,
      null,
      NOW,
    );
    expect(q.verdict).toBe("short");
  });

  it("is unknown when the posting states fewer than two minimums", () => {
    const q = evaluateQualification(posting("We need Python and enthusiasm."), profile, null, NOW);
    expect(q).toMatchObject({ verdict: "unknown", checks: [] });
    const one = evaluateQualification(posting("Minimum GPA of 3.0"), profile, null, NOW);
    expect(one.verdict).toBe("unknown");
  });

  it("doesn't count a minimum it can't judge", () => {
    const noGpa = testProfile((x) => ({
      ...x,
      education: [{ ...x.education[0]!, gpa: null }],
    }));
    const q = evaluateQualification(
      posting("Minimum Qualifications\nMinimum GPA of 3.0\nCurrently pursuing a Bachelor's degree"),
      noGpa,
      null,
      NOW,
    );
    expect(q.checks.find((c) => c.kind === "gpa")).toMatchObject({ met: null, have: null });
    expect(q.verdict).toBe("unknown"); // only the degree is judged
  });

  it("checks graduation windows and degree level", () => {
    const q = evaluateQualification(
      posting("Open to students graduating between December 2026 and June 2027."),
      profile,
      null,
      NOW,
    );
    expect(q.checks).toEqual([
      { kind: "graduation", need: "graduating 2026 to 2027", have: "graduating 2028", met: false },
    ]);
    const grad = evaluateQualification(posting("x", { degrees: ["Master's"] }), profile, null, NOW);
    expect(grad.checks[0]).toMatchObject({ kind: "degree", met: false });
  });

  it("uses the model's requirement match, one check per required skill", () => {
    const q = evaluateQualification(
      posting("Minimum GPA of 3.0"),
      profile,
      model(["Python", "Kubernetes", "SQL"], ["Python", "SQL"]),
      NOW,
    );
    expect(q.checks.filter((c) => c.kind === "skill")).toHaveLength(3);
    expect(q.verdict).toBe("close");
    expect(q.checks.find((c) => c.met === false)).toMatchObject({
      kind: "skill",
      need: "Kubernetes",
    });
  });

  it("ignores the offline keyword match: it has no list of requirements", () => {
    const q = evaluateQualification(
      posting("x"),
      profile,
      { required: [], matched: ["python"], missing: [], method: "keywords" },
      NOW,
    );
    expect(q.checks).toEqual([]);
  });

  it("never judges work authorization, only notes what the posting says", () => {
    const q = evaluateQualification(
      posting("Minimum GPA of 3.0", { sponsorship: "no_sponsorship" }),
      profile,
      null,
      NOW,
    );
    expect(q.checks.some((c) => /sponsor|authori/i.test(c.need))).toBe(false);
    expect(q.notes[0]).toMatch(/doesn't sponsor/);
  });
});
