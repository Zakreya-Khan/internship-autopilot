import { describe, expect, it } from "vitest";
import {
  applyResumePlan,
  buildBaseResume,
  buildFillPlan,
  checkClaims,
  classifyQuestion,
  diffResume,
  hasBlockingFlags,
  pickGradOption,
  pickNumericRange,
  pickOption,
  questionKey,
  resolveKnownField,
} from "../src/index.ts";
import type { FormQuestion } from "../src/index.ts";
import { testProfile } from "./fixtures.ts";

const profile = testProfile();
const q = (
  label: string,
  type: FormQuestion["type"] = "text",
  extra: Partial<FormQuestion> = {},
): FormQuestion => ({
  key: questionKey(label),
  label,
  required: true,
  type,
  ...extra,
});

describe("question classification", () => {
  it.each([
    ["First Name", "first_name"],
    ["Last Name", "last_name"],
    ["Email", "email"],
    ["LinkedIn Profile", "linkedin"],
    [
      "Will you now or in the future require sponsorship for employment visa status?",
      "needs_sponsorship",
    ],
    ["Are you legally authorized to work in the United States?", "authorized_us"],
    ["Expected graduation date", "grad_date"],
    ["What is your gender?", "eeo_gender"],
    ["Are you Hispanic/Latino?", "eeo_hispanic"],
    ["Veteran Status", "eeo_veteran"],
    ["How did you hear about this job?", "how_heard"],
  ])("%s → %s", (label, field) => {
    expect(classifyQuestion(q(label))).toEqual({ kind: "known", field });
  });

  it("routes attestations to you and never fills them", () => {
    expect(
      classifyQuestion(q("I certify that the information provided is true", "checkbox")).kind,
    ).toBe("user_only");
  });

  it("sends questions the profile can't answer to you", () => {
    for (const label of [
      "Do you know anyone who works here?",
      "Rate your C++ skills from 1 to 5",
      "What are your salary expectations?",
    ]) {
      expect(classifyQuestion(q(label)).kind).toBe("needs_you");
    }
  });

  it("drafts open-ended questions", () => {
    expect(classifyQuestion(q("Why do you want to work at Example Co?", "textarea"))).toEqual({
      kind: "open",
    });
  });
});

describe("labels from a real Greenhouse form", () => {
  it("treats SMS/WhatsApp consent as yours, not an email field", () => {
    const c = classifyQuestion(
      q(
        "Would you like to receive communications via SMS and/or WhatsApp to the phone number provided?",
        "select",
      ),
    );
    expect(c.kind).toBe("user_only");
  });

  it("picks a graduation option or refuses", () => {
    expect(pickGradOption(["Spring 2028", "Summer 2028", "Fall 2028"], "2028-05")).toBe(
      "Spring 2028",
    );
    expect(pickGradOption(["May 2028", "December 2028"], "2028-05")).toBe("May 2028");
    expect(pickGradOption(["2029", "2030"], "2028-05")).toBeNull();
  });

  it("picks the GPA range that holds your GPA", () => {
    const opts = ["3.75+", "3.41 - 3.74", "Below 3.4"];
    expect(pickNumericRange(opts, 3.7)).toBe("3.41 - 3.74");
    expect(pickNumericRange(opts, 3.9)).toBe("3.75+");
    expect(pickNumericRange(opts, 3.2)).toBe("Below 3.4");
    expect(resolveKnownField("gpa", { type: "select", options: opts }, profile)).toBe(
      "3.41 - 3.74",
    );
  });

  it("leaves the paste-your-resume text box empty when the file is attached", () => {
    const plan = buildFillPlan(
      [{ key: "resume_text", label: "Resume/CV", required: true, type: "textarea" }],
      profile,
      new Map(),
      new Map(),
    );
    expect(plan[0]).toMatchObject({
      value: null,
      flag: null,
      note: "Not needed: the file is attached.",
    });
    expect(plan[0]).not.toHaveProperty("attach");
  });
});

describe("option picking", () => {
  it("never guesses", () => {
    expect(pickOption(["Yes", "No"], false)).toBe("No");
    expect(pickOption(["Yes, I will", "No, I won't"], true)).toBe("Yes, I will");
    expect(pickOption(["Male", "Female", "I don't wish to answer"], "decline")).toBe(
      "I don't wish to answer",
    );
    expect(pickOption(["Male", "Female"], "decline")).toBeNull();
    expect(pickOption(["Option A", "Option B"], "Something else")).toBeNull();
  });

  it("answers sponsorship and EEO from saved choices", () => {
    expect(
      resolveKnownField("needs_sponsorship", { type: "select", options: ["Yes", "No"] }, profile),
    ).toBe("No");
    expect(
      resolveKnownField(
        "eeo_veteran",
        {
          type: "select",
          options: ["I am a protected veteran", "I am not a protected veteran", "Decline"],
        },
        profile,
      ),
    ).toBe("I am not a protected veteran");
    expect(resolveKnownField("grad_date", { type: "text" }, profile)).toBe("May 2028");
    expect(resolveKnownField("first_name", { type: "text" }, profile)).toBe("Alex");
  });
});

describe("fill plan", () => {
  const questions = [
    q("First Name"),
    q("Resume/CV", "file"),
    q("Why Example Co?", "textarea"),
    q("Do you know anyone who works here?", "select", { options: ["Yes", "No"] }),
    q("I acknowledge the privacy notice", "checkbox", { required: false }),
    q("Gender", "select", { required: false, options: ["Male", "Female"] }),
  ];

  it("fills what it can, flags the rest, and blocks on required unknowns", () => {
    const drafted = new Map([
      ["why_example_co", { questionKey: "why_example_co", text: "Draft.", flagged: false }],
    ]);
    const plan = buildFillPlan(questions, profile, drafted, new Map());
    const by = Object.fromEntries(plan.map((f) => [f.label, f]));
    expect(by["First Name"]).toMatchObject({ value: "Alex", source: "profile", flag: null });
    expect(by["Resume/CV"]).toMatchObject({ attach: "resume" });
    expect(by["Why Example Co?"]).toMatchObject({ value: "Draft.", source: "drafted" });
    expect(by["Do you know anyone who works here?"]).toMatchObject({ value: null, flag: "red" });
    expect(by["I acknowledge the privacy notice"]).toMatchObject({ value: null, flag: "grey" });
    expect(by["Gender"]).toMatchObject({ value: null, flag: "amber" });
    expect(hasBlockingFlags(plan)).toBe(true);
  });

  it("reuses an answer you gave on an earlier form", () => {
    const learned = new Map([
      [questionKey("Do you know anyone who works here?"), { answer: "No" }],
    ]);
    const plan = buildFillPlan(questions.slice(3, 4), profile, new Map(), learned);
    expect(plan[0]).toMatchObject({ value: "No", source: "you", flag: null });
  });
});

describe("truth checks", () => {
  const check = (text: string, factIds: string[], mustCite = true, context?: string) =>
    checkClaims(profile, [
      { where: "t", text, factIds, mustCite, ...(context ? { context } : {}) },
    ]);

  it("passes a faithful rewording", () => {
    expect(
      check("Built a Python data pipeline that cleaned three years of sensor data", ["exp.lab.f1"]),
    ).toEqual([]);
  });

  it("allows a verified number, blocks an invented one", () => {
    expect(check("Cut the nightly job from 6 hours to 40 minutes", ["exp.lab.f2"])).toEqual([]);
    expect(
      check("Cut the nightly job runtime by 90%", ["exp.lab.f2"]).map((i) => i.problem),
    ).toContain('number "90%" isn\'t in the cited facts');
  });

  it("matches numbers written with thousands separators", () => {
    const p = testProfile((x) => ({
      ...x,
      experience: [
        ...x.experience,
        {
          id: "exp.shop",
          org: "Example Garden Club",
          title: "Volunteer",
          start: "2025-03",
          end: "present",
          on_base_resume: true,
          facts: [
            {
              id: "exp.shop.f1",
              text: "Sorted 12,500+ seed packets",
              tools: [],
              verified_metric: "12,500+",
            },
          ],
        },
      ],
    }));
    const run = (text: string) =>
      checkClaims(p, [{ where: "t", text, factIds: ["exp.shop.f1"], mustCite: true }]);
    expect(run("Sorted 12,500+ seed packets for members.")).toEqual([]);
    expect(run("Sorted 12500 seed packets")).toEqual([]);
    expect(run("Sorted 42,500+ seed packets").map((i) => i.severity)).toContain("block");
  });

  it("blocks technologies that aren't in the profile", () => {
    const issues = check("Built a Python pipeline on Kubernetes that cleaned sensor data", [
      "exp.lab.f1",
    ]);
    expect(issues.map((i) => i.problem)).toContain(
      "mentions kubernetes, which isn't in your profile",
    );
  });

  it("lets an answer name a technology from the posting itself", () => {
    expect(
      check("I'd like to learn Kubernetes on your team.", [], false, "We use Kubernetes."),
    ).toEqual([]);
  });

  it("blocks inflated skill levels", () => {
    const issues = check("Expert in SQL and Python data pipelines that cleaned sensor data", [
      "exp.lab.f1",
    ]);
    expect(issues.map((i) => i.problem)).toContain(
      'describes sql too strongly; your level is "coursework"',
    );
  });

  it("blocks uncited and unknown citations, and warns on drift", () => {
    expect(check("Led a team of engineers", []).map((i) => i.problem)).toContain(
      "makes a claim without citing a fact",
    );
    expect(check("Built things", ["exp.nope"]).map((i) => i.problem)).toContain(
      "cites unknown fact ids: exp.nope",
    );
    const drift = check("Championed cross-functional stakeholder alignment initiatives", [
      "exp.lab.f1",
    ]);
    expect(drift).toEqual([expect.objectContaining({ severity: "warn" })]);
  });
});

describe("resume plans and diffs", () => {
  const base = buildBaseResume(profile);

  it("applies a plan and rejects anything outside the profile", () => {
    const { doc, problems } = applyResumePlan(profile, {
      entries: [
        {
          entryId: "exp.lab",
          bullets: [
            {
              text: "Cut the nightly processing job from 6 hours to 40 minutes",
              factIds: ["exp.lab.f2"],
            },
            { text: "Built the course scheduler", factIds: ["proj.app.f1"] },
            { text: "Did something", factIds: [] },
          ],
        },
      ],
      skillsOrder: ["Python", "Kubernetes", "react"],
      courses: ["databases", "quantum-computing"],
    });
    expect(doc.experience[0]!.bullets).toHaveLength(1);
    expect(doc.projects).toHaveLength(0);
    expect(doc.skills).toEqual(["python", "react"]);
    expect(doc.education[0]!.courses).toEqual(["databases"]);
    expect(problems.map((p) => p.problem).sort()).toEqual(
      [
        "bullet cites facts outside this entry: proj.app.f1",
        'bullet cites no fact: "Did something"',
        '"Kubernetes" is not in your skills',
        '"quantum-computing" is not in your courses',
      ].sort(),
    );
  });

  it("keeps off-resume entries out of the base, but lets a plan pull them in", () => {
    const p = testProfile((x) => ({
      ...x,
      projects: x.projects.map((e) => ({ ...e, on_base_resume: false })),
    }));
    const b = buildBaseResume(p);
    expect(b.projects).toEqual([]);
    const { doc, problems } = applyResumePlan(p, {
      entries: [
        {
          entryId: "exp.lab",
          bullets: [
            {
              text: "Built a Python pipeline that cleaned three years of sensor data",
              factIds: ["exp.lab.f1"],
            },
          ],
        },
        {
          entryId: "proj.app",
          bullets: [
            {
              text: "Wrote a web app that builds conflict-free class schedules",
              factIds: ["proj.app.f1"],
            },
          ],
        },
      ],
      skillsOrder: [],
      courses: [],
    });
    expect(problems).toEqual([]);
    expect(doc.projects.map((e) => e.id)).toEqual(["proj.app"]);
    const d = diffResume(b, doc);
    expect(d.bullets.find((x) => x.entryId === "proj.app")).toMatchObject({ status: "added" });
  });

  it("diffs at the bullet level with word changes", () => {
    const { doc } = applyResumePlan(profile, {
      entries: [
        {
          entryId: "exp.lab",
          bullets: [
            {
              text: "Cut the nightly processing job from 6 hours to 40 minutes",
              factIds: ["exp.lab.f2"],
            },
            {
              text: "Built a Python and pandas pipeline that cleaned three years of sensor data",
              factIds: ["exp.lab.f1"],
            },
          ],
        },
        {
          entryId: "proj.app",
          bullets: [
            {
              text: "Wrote a web app that builds conflict-free class schedules",
              factIds: ["proj.app.f1"],
            },
          ],
        },
      ],
      skillsOrder: ["typescript", "python", "react"],
      courses: [],
    });
    const d = diffResume(base, doc);
    expect(d.summary).toEqual({ kept: 2, reworded: 1, added: 0, removed: 0 });
    const reworded = d.bullets.find((b) => b.status === "reworded")!;
    expect(reworded.words?.some((w) => w.added && w.value.includes("pandas"))).toBe(true);
    expect(reworded.moved).toBe(1);
    expect(d.skillsMoved[0]).toEqual({ skill: "typescript", from: 1, to: 0 });
    expect(d.skillsDropped).toEqual(["sql", "go"]);
  });
});
