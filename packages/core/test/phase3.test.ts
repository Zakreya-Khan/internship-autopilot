import { describe, expect, it } from "vitest";
import {
  classifyEmail,
  mapPageFieldsByRules,
  matchEmail,
  outcomeReport,
  parseEmail,
  scoreBand,
  splitMbox,
  statusFromEmail,
  toDelimited,
} from "../src/index.ts";
import type { OutcomeRow } from "../src/index.ts";
import { testProfile } from "./fixtures.ts";

const row = (over: Partial<OutcomeRow>): OutcomeRow => ({
  id: 1,
  company: "Example Co",
  title: "Intern",
  status: "submitted",
  tier: "B",
  score: 72,
  ats: "greenhouse",
  sources: ["greenhouse", "simplify"],
  roleFamily: "swe",
  submittedAt: "2026-11-01T00:00:00Z",
  nextAction: null,
  nextActionDue: null,
  contact: null,
  ...over,
});

describe("outcome report", () => {
  const now = new Date("2026-12-15T00:00:00Z");
  const rows = [
    row({ id: 1, status: "interview", score: 91, tier: "A" }),
    row({ id: 2, status: "rejected", score: 74 }),
    row({ id: 3, status: "submitted", score: 66, submittedAt: "2026-11-01T00:00:00Z" }),
    row({
      id: 4,
      status: "submitted",
      score: 70,
      submittedAt: "2026-11-28T00:00:00Z",
      contact: "a recruiter",
    }),
    row({ id: 5, status: "ready", score: 80 }),
    row({
      id: 6,
      status: "online_assessment",
      nextAction: "Finish OA",
      nextActionDue: "2026-12-18",
    }),
  ];
  const r = outcomeReport(rows, now);

  it("computes reply and positive rates over sent applications only", () => {
    expect(r.totals.sent).toBe(5);
    expect(r.byTier).toEqual([
      { key: "A", submitted: 1, responded: 1, positive: 1, rate: 1, positiveRate: 1 },
      { key: "B", submitted: 4, responded: 2, positive: 1, rate: 0.5, positiveRate: 0.25 },
    ]);
    expect(r.byScoreBand.map((b) => b.key)).toEqual(["60-69", "70-79", "90+"]);
    expect(scoreBand(null)).toBe("unscored");
  });

  it("lists what's due and suggests no-response and follow-ups", () => {
    expect(r.dueSoon).toEqual([
      {
        id: 6,
        company: "Example Co",
        title: "Intern",
        nextAction: "Finish OA",
        nextActionDue: "2026-12-18",
      },
    ]);
    expect(r.suggestions).toEqual([
      expect.objectContaining({ applicationId: 3, kind: "mark_no_response" }),
      expect.objectContaining({ applicationId: 4, kind: "follow_up" }),
    ]);
  });
});

const MBOX = `From recruiting@exampleco.com Mon Dec 01 10:00:00 2026
From: Example Co Recruiting <recruiting@exampleco.com>
Subject: =?utf-8?Q?Your_application_to_Example_Co?=
Date: Mon, 01 Dec 2026 10:00:00 +0000
Content-Type: multipart/alternative; boundary="b1"

--b1
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

Hi Alex, we'd like to invite you to an online assessment on Code=
Signal. Please complete it within 5 days.
--b1--
From no-reply@other.test Tue Dec 02 10:00:00 2026
From: Other Co <no-reply@other.test>
Subject: Update on your application
Date: Tue, 02 Dec 2026 10:00:00 +0000

Unfortunately we will not be moving forward.
`;

describe("email", () => {
  it("splits an mbox and parses headers, encodings and multipart bodies", () => {
    const msgs = splitMbox(MBOX).map(parseEmail);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({
      subject: "Your application to Example Co",
      date: "2026-12-01T10:00:00.000Z",
    });
    expect(msgs[0]!.body).toContain("online assessment on CodeSignal");
  });

  it.each([
    [
      "Next steps: online assessment",
      "Please complete the HackerRank challenge",
      "online_assessment",
    ],
    ["Interview invitation", "We'd like to schedule an interview", "interview"],
    ["Your application", "Unfortunately, we have decided not to proceed", "rejected"],
    ["Offer", "We are pleased to extend an offer", "offer"],
    ["Thanks", "Thank you for applying to Example Co", "received"],
    ["Newsletter", "Our latest blog posts", null],
  ])("classifies %s", (subject, body, outcome) => {
    expect(classifyEmail({ subject, body })).toBe(outcome);
  });

  it("matches by company name or sender domain, and only moves status forward", () => {
    const apps = [
      { id: 1, company: "Example Co", status: "submitted" as const, submittedAt: "2026-11-01" },
      { id: 2, company: "Other Co", status: "offer" as const, submittedAt: "2026-11-01" },
    ];
    const [e1, e2] = splitMbox(MBOX).map(parseEmail);
    expect(matchEmail(e1!, apps)?.id).toBe(1);
    expect(
      matchEmail({ from: "jobs@exampleco.com", subject: "Hi", date: null, body: "" }, apps)?.id,
    ).toBe(1);
    expect(
      matchEmail({ from: "x@unknown.test", subject: "Hi", date: null, body: "" }, apps),
    ).toBeNull();
    expect(statusFromEmail("submitted", "online_assessment")).toBe("online_assessment");
    expect(statusFromEmail("offer", classifyEmail(e2!))).toBeNull();
    expect(statusFromEmail("submitted", "received")).toBeNull();
  });
});

describe("export", () => {
  it("quotes CSV, flattens TSV, and defuses spreadsheet formulas", () => {
    const rows = [{ a: 'Say "hi", ok', b: "=HYPERLINK(1)", c: ["x", "y"], d: null }];
    expect(toDelimited(rows, ["a", "b", "c", "d"])).toBe(
      `a,b,c,d\r\n"Say ""hi"", ok",'=HYPERLINK(1),x; y,\r\n`,
    );
    expect(toDelimited([{ a: "two\tparts\nhere" }], ["a"], "\t")).toBe("a\r\ntwo parts here\r\n");
  });
});

describe("field mapping on unknown sites", () => {
  it("uses plan labels and profile fields, never guesses the rest", () => {
    const plan = [
      {
        key: "q1",
        label: "Tell us about a project you're proud of",
        value: "The scheduler.",
        attach: null,
      },
    ];
    const { mapped, unmatched } = mapPageFieldsByRules(
      [
        { key: "ia-0", label: "Your full name", type: "text", required: true },
        { key: "ia-1", label: "E-mail", type: "text", required: true },
        { key: "ia-2", label: "CV upload", type: "file", required: false },
        {
          key: "ia-3",
          label: "Do you need visa sponsorship?",
          type: "radio",
          required: false,
          options: ["Yes", "No"],
        },
        {
          key: "ia-4",
          label: "Tell us about a project you're proud of",
          type: "textarea",
          required: false,
        },
        { key: "ia-5", label: "I agree to the privacy policy", type: "checkbox", required: true },
        { key: "ia-6", label: "Favourite snack", type: "text", required: false },
      ],
      plan,
      testProfile(),
    );
    const by = Object.fromEntries(mapped.map((m) => [m.key, m]));
    expect(by["ia-0"]).toMatchObject({ value: "Alex Example", via: "profile_field" });
    expect(by["ia-1"]).toMatchObject({ value: "alex@example.com" });
    expect(by["ia-2"]).toMatchObject({ attach: "resume" });
    expect(by["ia-3"]).toMatchObject({ value: "No" });
    expect(by["ia-4"]).toMatchObject({ value: "The scheduler.", via: "same_label" });
    expect(by["ia-5"]).toMatchObject({ value: null, via: "none" });
    expect(unmatched.map((u) => u.key)).toEqual(["ia-6"]);
  });
});
