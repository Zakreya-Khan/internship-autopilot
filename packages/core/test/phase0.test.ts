import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyHardFilters,
  canonicalizeUrl,
  canTransition,
  classifyRoleFamily,
  computeFitScore,
  costUsd,
  degreeExcludes,
  detectSponsorship,
  detectTerms,
  finalizePosting,
  gradYearsMentioned,
  indexFacts,
  isUsRemote,
  isSameRole,
  markMissing,
  parseAtsUrl,
  parseProfile,
  similarity,
  upsertAll,
} from "../src/index.ts";
import { makePosting, testProfile, TEST_PROFILE_YAML } from "./fixtures.ts";

describe("profile", () => {
  it("parses the shipped example profile", () => {
    const text = readFileSync(new URL("../../../profile.example.yaml", import.meta.url), "utf8");
    const p = parseProfile(text);
    expect(p.preferences.terms).toEqual(["Summer 2027"]);
    expect(p.eeo.gender).toBe("decline");
  });

  it("indexes every citable fact", () => {
    const facts = indexFacts(testProfile());
    expect([...facts.keys()]).toEqual(
      expect.arrayContaining([
        "edu.main",
        "exp.lab.f1",
        "exp.lab.f2",
        "proj.app.f1",
        "ans.why_field",
      ]),
    );
    expect(facts.get("exp.lab.f2")?.verifiedMetric).toBe("6 hours to 40 minutes");
  });

  it("rejects duplicate fact ids", () => {
    const dup = TEST_PROFILE_YAML.replace("id: proj.app.f1", "id: exp.lab.f1");
    expect(() => parseProfile(dup)).toThrow(/Duplicate fact id/);
  });

  it("explains invalid profiles by path", () => {
    expect(() => parseProfile("identity: {}\neducation: []")).toThrow(/identity\.name/);
  });
});

describe("ATS urls", () => {
  it.each([
    ["https://job-boards.greenhouse.io/exampleco/jobs/123", "greenhouse", "exampleco", "123"],
    ["https://boards.greenhouse.io/embed/job_app?for=acme&token=55", "greenhouse", "acme", "55"],
    ["https://acme.com/careers?gh_jid=77", "greenhouse", null, "77"],
    ["https://jobs.lever.co/acme/1f2e-aa/apply", "lever", "acme", "1f2e-aa"],
    ["https://jobs.ashbyhq.com/acme/9a8b/application", "ashby", "acme", "9a8b"],
    [
      "https://uva.wd1.myworkdayjobs.com/uvastudentjobs/job/Charlottesville-VA/StatLab-Associate_R0081481",
      "workday",
      "uva",
      "R0081481",
    ],
    [
      "https://jobs.smartrecruiters.com/Acme/7444-software-intern",
      "smartrecruiters",
      "Acme",
      "7444",
    ],
    ["https://careers-acme.icims.com/jobs/4321/intern/job", "icims", "acme", "4321"],
    ["https://example.org/jobs/1", "other", null, null],
  ])("%s", (url, ats, token, job) => {
    expect(parseAtsUrl(url)).toEqual({ ats, boardToken: token, jobId: job });
  });

  it("strips tracking params but keeps gh_jid", () => {
    expect(canonicalizeUrl("https://ACME.com/careers/?gh_jid=7&utm_source=x&gh_src=y#top")).toBe(
      "https://acme.com/careers?gh_jid=7",
    );
  });
});

describe("classification", () => {
  it("prefers the list category, then the title", () => {
    expect(classifyRoleFamily("Intern", "AI/ML/Data")).toBe("data_ml");
    expect(classifyRoleFamily("Quantitative Trading Intern")).toBe("quant");
    expect(classifyRoleFamily("Backend Software Engineer Intern")).toBe("swe");
    expect(classifyRoleFamily("FPGA Design Intern")).toBe("hardware");
    expect(classifyRoleFamily("Associate Product Manager Intern")).toBe("pm");
  });

  it("finds terms", () => {
    expect(detectTerms("Software Intern - Summer 2027 / Fall '27")).toEqual([
      "Summer 2027",
      "Fall 2027",
    ]);
  });

  it("reads sponsorship from the flag and the text, stricter wins", () => {
    expect(detectSponsorship("Other", "We do not offer visa sponsorship for this role.")).toBe(
      "no_sponsorship",
    );
    expect(detectSponsorship("Offers Sponsorship", "Requires an active security clearance")).toBe(
      "citizenship_required",
    );
    expect(detectSponsorship("Other", "Great team.")).toBe("unknown");
  });

  it("degree lists exclude only when they name other levels", () => {
    expect(degreeExcludes(["Master's", "PhD"], "bachelors")).toBe(true);
    expect(degreeExcludes(["Bachelor's", "Master's"], "bachelors")).toBe(false);
    expect(degreeExcludes([], "bachelors")).toBe(false);
  });

  it("finds graduation windows", () => {
    expect(gradYearsMentioned("Students graduating between December 2027 and June 2028.")).toEqual([
      2027, 2028,
    ]);
    expect(gradYearsMentioned("Open to the class of 2029")).toEqual([2029]);
  });
});

describe("dedupe", () => {
  it("merges the same role seen in the list and the API, keeping both links", () => {
    const now = "2026-11-17T00:00:00.000Z";
    const fromList = finalizePosting(
      {
        ...makePosting(),
        applyUrl: "https://job-boards.greenhouse.io/exampleco/jobs/555?utm_source=simplify",
        ats: "other",
        boardToken: null,
        atsJobId: null,
        sources: ["simplify"],
        descriptionText: null,
        sourceLinks: ["https://github.com/SimplifyJobs/Summer2027-Internships"],
      },
      now,
    );
    const fromApi = finalizePosting(
      {
        ...makePosting(),
        applyUrl: "https://job-boards.greenhouse.io/exampleco/jobs/555",
        sources: ["greenhouse"],
      },
      now,
    );
    expect(fromList.id).toBe("greenhouse:exampleco:555");
    const r = upsertAll([fromList], [fromApi]);
    expect(r).toMatchObject({ added: 0, merged: 1 });
    expect(r.postings[0]!.sources.sort()).toEqual(["greenhouse", "simplify"]);
    expect(r.postings[0]!.descriptionText).toContain("Python");
  });

  it("fuzzy-matches near-identical titles at one company", () => {
    const a = makePosting({ id: "url:a", title: "Software Engineer Intern (Summer 2027)" });
    const b = makePosting({
      id: "url:b",
      title: "Software Engineer Intern - Summer 2027",
      atsJobId: null,
    });
    expect(isSameRole(a, b)).toBe(true);
    expect(isSameRole(a, makePosting({ id: "url:c", company: "Other Co", atsJobId: null }))).toBe(
      false,
    );
    expect(similarity("data intern", "hardware intern")).toBeLessThan(0.9);
  });

  it("closes a role after two missed polls", () => {
    const p = makePosting();
    const once = markMissing([p], new Set(), () => true);
    expect(once[0]).toMatchObject({ missedPolls: 1, isOpen: true });
    const twice = markMissing(once, new Set(), () => true);
    expect(twice[0]).toMatchObject({ missedPolls: 2, isOpen: false });
  });
});

describe("hard filters", () => {
  const profile = testProfile();
  it("passes a matching posting", () => {
    expect(applyHardFilters(makePosting(), profile)).toEqual({ pass: true, reasons: [] });
  });

  it.each([
    [{ isOpen: false }, /closed/],
    [{ terms: ["Fall 2026"] }, /term/],
    [{ roleFamily: "quant" as const }, /role family/],
    [{ locations: ["Austin, TX"] }, /location/],
    [{ sponsorship: "citizenship_required" as const }, /citizenship/],
    [{ degrees: ["PhD"] }, /degree/],
    [{ descriptionText: "Must be graduating between Dec 2026 and May 2027." }, /graduation window/],
    [{ title: "Software Co-op" }, /co-op/],
  ])("drops %o", (partial, reason) => {
    const r = applyHardFilters(makePosting(partial), profile);
    expect(r.pass).toBe(false);
    expect(r.reasons.join(" ")).toMatch(reason);
  });

  it("drops no-sponsorship roles only when you need sponsorship", () => {
    const p = makePosting({ sponsorship: "no_sponsorship" });
    expect(applyHardFilters(p, profile).pass).toBe(true);
    const needs = testProfile((x) => ({
      ...x,
      work_authorization: { ...x.work_authorization, needs_sponsorship_later: true },
    }));
    expect(applyHardFilters(p, needs).reasons).toContain("no visa sponsorship");
  });

  it.each([
    ["Remote", true],
    ["Remote - US", true],
    ["Remote in USA", true],
    ["Remote (United States)", true],
    ["Remote in India", false],
    ["London, UK", false],
  ])("treats %s as U.S. remote: %s", (loc, ok) => {
    expect(isUsRemote(loc)).toBe(ok);
  });

  it("only ranks by location when strict_locations is off", () => {
    const loose = testProfile((x) => ({
      ...x,
      preferences: { ...x.preferences, strict_locations: false },
    }));
    const austin = makePosting({ locations: ["Austin, TX"] });
    expect(applyHardFilters(austin, loose).pass).toBe(true);
    const now = new Date("2026-11-17T00:00:00Z");
    expect(computeFitScore(austin, loose, undefined, now).components.location).toBe(0);
    expect(computeFitScore(makePosting(), loose, undefined, now).components.location).toBe(10);
  });

  it("keeps remote roles when remote is allowed", () => {
    expect(applyHardFilters(makePosting({ locations: ["Remote - US"] }), profile).pass).toBe(true);
  });
});

describe("fit score", () => {
  const profile = testProfile();
  const now = new Date("2026-11-17T00:00:00Z");

  it("scores a strong match into Tier A with a model match", () => {
    const fit = computeFitScore(
      makePosting(),
      profile,
      {
        required: ["python", "typescript"],
        matched: ["python", "typescript"],
        missing: [],
        method: "model",
      },
      now,
    );
    expect(fit.components.skills).toBe(30);
    expect(fit.score).toBeGreaterThanOrEqual(80);
    expect(fit.tier).toBe("A");
  });

  it("caps the offline keyword fallback below full skill marks", () => {
    const fit = computeFitScore(makePosting(), profile, undefined, now);
    expect(fit.match.method).toBe("keywords");
    expect(fit.match.matched).toEqual(
      expect.arrayContaining(["python", "typescript", "react", "sql"]),
    );
    expect(fit.components.skills).toBeLessThanOrEqual(24);
  });

  it("puts target companies in Tier A regardless of score", () => {
    const weak = makePosting({
      company: "Dream Corp",
      descriptionText: "Cobol mainframes.",
      locations: ["Austin"],
    });
    const fit = computeFitScore(weak, profile, undefined, now);
    expect(fit.score).toBeLessThan(80);
    expect(fit.tier).toBe("A");
  });

  it("ages postings", () => {
    const old = computeFitScore(
      makePosting({ firstSeen: "2026-09-01T00:00:00Z" }),
      profile,
      undefined,
      now,
    );
    expect(old.components.freshness).toBe(2);
  });
});

describe("status machine", () => {
  it("only lets confirmation or the user move filled to submitted", () => {
    expect(canTransition("approved", "submitted")).toBe(false);
    expect(canTransition("filled", "submitted")).toBe(true);
    expect(canTransition("ready", "approved")).toBe(true);
    expect(canTransition("rejected", "offer")).toBe(false);
  });
});

describe("cost", () => {
  it("matches the spec's Tier B drafting estimate", () => {
    const usd = costUsd("claude-opus-5-5", {
      input_tokens: 5000,
      output_tokens: 6000,
      cache_read_input_tokens: 10000,
    });
    expect(usd).toBeCloseTo(0.142, 3);
    expect(
      costUsd("claude-opus-5-5", { input_tokens: 1e6, output_tokens: 0 }, { batch: true }),
    ).toBe(2);
    expect(costUsd("unknown-model", { input_tokens: 1, output_tokens: 1 })).toBe(0);
  });
});
