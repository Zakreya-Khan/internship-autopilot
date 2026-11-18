import { describe, expect, it } from "vitest";
import {
  checkPostingOpen,
  classifyPage,
  closureStatement,
  HostRateLimiter,
  jobIdToken,
  normalizeForMatch,
  pageEvidenceFromHtml,
} from "../src/index.ts";
import type { FetchFn, LivenessRef } from "../src/index.ts";

type Route = { status?: number; body?: unknown; headers?: Record<string, string>; url?: string };

function routes(table: Record<string, Route>) {
  const calls: string[] = [];
  const fn: FetchFn = async (url) => {
    calls.push(url);
    const key = Object.keys(table)
      .sort((a, b) => b.length - a.length)
      .find((k) => url.startsWith(k));
    if (!key) throw new Error(`unexpected fetch ${url}`);
    const r = table[key]!;
    const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
    const res = new Response(body, { status: r.status ?? 200, headers: r.headers ?? {} });
    if (r.url) Object.defineProperty(res, "url", { value: r.url });
    return res;
  };
  return { fn, calls };
}

const opts = (fetch: FetchFn) => ({ fetch, limiter: new HostRateLimiter(0) });

const LONG = "Example Co builds tools for schools. ".repeat(12);

describe("normalizeForMatch", () => {
  it("folds curly quotes, accents and whitespace", () => {
    expect(normalizeForMatch("Cette offre n’est plus  disponible – déjà")).toBe(
      "Cette offre n'est plus disponible – deja",
    );
    expect(normalizeForMatch(null)).toBe("");
  });
});

describe("closure text", () => {
  it("matches closure banners written with typographic apostrophes", () => {
    expect(closureStatement("Sorry — we’re no longer accepting applications.")).toBe(
      "no longer accepting applications",
    );
    expect(closureStatement("You can’t view this job because it’s not available")).not.toBeNull();
    expect(closureStatement("This position has been filled.")).not.toBeNull();
  });

  it("ignores conditional wording", () => {
    expect(
      closureStatement("Applications are accepted until the position has been filled."),
    ).toBeNull();
    expect(
      closureStatement("We review applications on a rolling basis. Are applications closed?"),
    ).toBeNull();
    expect(
      closureStatement("Please make sure the application form has been filled out"),
    ).toBeNull();
    expect(closureStatement("Our closed-loop controls team builds robots")).toBeNull();
  });

  it("still catches a closure banner on its own line after a condition elsewhere", () => {
    expect(
      closureStatement("We hire until all roles are staffed\nThis job is no longer available"),
    ).not.toBeNull();
  });
});

describe("classifyPage", () => {
  const base = {
    status: 200,
    requestedUrl: "https://x.test/jobs/123456",
    finalUrl: "https://x.test/jobs/123456",
  };

  it("404 and 410 are definitive", () => {
    expect(classifyPage({ ...base, status: 410, bodyText: "", applyControls: [] }).verdict).toBe(
      "expired",
    );
  });

  it("blocked, rate-limited and challenged pages are uncertain, never expired", () => {
    for (const status of [401, 403, 429, 503, 500])
      expect(classifyPage({ ...base, status, bodyText: "", applyControls: [] }).verdict).toBe(
        "uncertain",
      );
    expect(
      classifyPage({
        ...base,
        bodyText: "Just a moment... job no longer available",
        applyControls: [],
      }).code,
    ).toBe("bot_challenge");
  });

  it("an apply control means active; a short page with none is uncertain", () => {
    expect(
      classifyPage({ ...base, bodyText: LONG, applyControls: ["Apply for this job"] }).verdict,
    ).toBe("active");
    expect(
      classifyPage({ ...base, bodyText: "Loading", applyControls: ["Sign in"] }),
    ).toMatchObject({
      verdict: "uncertain",
      code: "insufficient_content",
    });
  });

  it("an error redirect or a lost job id are judged differently", () => {
    expect(
      classifyPage({
        ...base,
        finalUrl: "https://x.test/board?error=true",
        bodyText: LONG,
        applyControls: [],
      }).verdict,
    ).toBe("expired");
    expect(
      classifyPage({
        ...base,
        finalUrl: "https://x.test/careers",
        bodyText: LONG,
        applyControls: ["Apply"],
      }),
    ).toMatchObject({ verdict: "uncertain", code: "redirected_off_posting" });
  });

  it("finds the last long id in a URL", () => {
    expect(jobIdToken("https://jobs.lever.co/a/8b1f5c6e-1234-4abc-9def-0123456789ab")).toBe(
      "8b1f5c6e-1234-4abc-9def-0123456789ab",
    );
    expect(jobIdToken("https://x.test/a")).toBeNull();
  });
});

describe("pageEvidenceFromHtml", () => {
  it("reads visible text and control labels, skipping scripts", () => {
    const e = pageEvidenceFromHtml(
      `<html><script>var x="no longer accepting applications"</script><h1>Intern</h1><p>Hi&nbsp;there</p><a href="#"><span>Apply</span> now</a><button>Save</button></html>`,
    );
    expect(e.bodyText).toContain("Hi there");
    expect(e.bodyText).not.toContain("accepting");
    expect(e.applyControls).toEqual(["Apply now", "Save"]);
  });
});

describe("checkPostingOpen via each board's API", () => {
  const gh: LivenessRef = {
    ats: "greenhouse",
    boardToken: "exampleco",
    atsJobId: "501",
    applyUrl: "https://job-boards.greenhouse.io/exampleco/jobs/501",
  };

  it("Greenhouse: 200 active, 404 expired", async () => {
    const live = routes({
      "https://boards-api.greenhouse.io/v1/boards/exampleco/jobs/501": { body: { id: 501 } },
    });
    expect(await checkPostingOpen(gh, opts(live.fn))).toMatchObject({
      verdict: "active",
      via: "api",
    });
    const gone = routes({ "https://boards-api.greenhouse.io/": { status: 404 } });
    expect(await checkPostingOpen(gh, opts(gone.fn))).toMatchObject({
      verdict: "expired",
      code: "greenhouse_api_gone",
    });
  });

  it("Greenhouse gh_jid links resolve the board through the embed redirect", async () => {
    const { fn, calls } = routes({
      "https://boards.greenhouse.io/embed/job_app": {
        status: 302,
        headers: {
          location: "https://job-boards.greenhouse.io/embed/job_app?for=exampleco&token=777",
        },
      },
      "https://boards-api.greenhouse.io/v1/boards/exampleco/jobs/777": { status: 404 },
    });
    const r = await checkPostingOpen(
      {
        ats: "greenhouse",
        boardToken: null,
        atsJobId: "777",
        applyUrl: "https://example.com/careers?gh_jid=777",
      },
      opts(fn),
    );
    expect(r.verdict).toBe("expired");
    expect(calls).toHaveLength(2);
  });

  it("Greenhouse: a 429 falls back to the page, which keeps it when unclear", async () => {
    const { fn } = routes({
      "https://boards-api.greenhouse.io/": { status: 429 },
      "https://job-boards.greenhouse.io/": { status: 200, body: "<div id=app></div>" },
    });
    expect((await checkPostingOpen(gh, opts(fn))).verdict).toBe("uncertain");
  });

  it("Lever: an API 404 decides nothing; the page does", async () => {
    const ref: LivenessRef = {
      ats: "lever",
      boardToken: "acme",
      atsJobId: "8b1f5c6e-1234-4abc-9def-0123456789ab",
      applyUrl: "https://jobs.lever.co/acme/8b1f5c6e-1234-4abc-9def-0123456789ab/apply",
    };
    const { fn } = routes({
      "https://api.lever.co/": { status: 404 },
      "https://jobs.lever.co/": {
        status: 200,
        body: `<p>${LONG}</p><p>Sorry, this job was removed</p>`,
      },
    });
    expect(await checkPostingOpen(ref, opts(fn))).toMatchObject({
      verdict: "expired",
      via: "page",
    });
  });

  it("Ashby: unlisted means expired, and the board is read once per run", async () => {
    const { fn, calls } = routes({
      "https://api.ashbyhq.com/posting-api/job-board/acme": {
        body: {
          jobs: [
            { id: "J1", isListed: true },
            { id: "J2", isListed: false },
          ],
        },
      },
    });
    const o = { ...opts(fn), boardCache: new Map() };
    const ref = (id: string): LivenessRef => ({
      ats: "ashby",
      boardToken: "acme",
      atsJobId: id,
      applyUrl: `https://jobs.ashbyhq.com/acme/${id}/application`,
    });
    expect((await checkPostingOpen(ref("j1"), o)).verdict).toBe("active");
    expect((await checkPostingOpen(ref("J2"), o)).verdict).toBe("expired");
    expect((await checkPostingOpen(ref("J3"), o)).verdict).toBe("expired");
    expect(calls).toHaveLength(1);
  });

  it("Workday: 404 and the S22 withdrawn code are expired; other 403s are not", async () => {
    const ref: LivenessRef = {
      ats: "workday",
      boardToken: "acme",
      atsJobId: "R1",
      applyUrl: "https://acme.wd3.myworkdayjobs.com/en-US/External/job/Austin/Intern_R1",
    };
    const at = "https://acme.wd3.myworkdayjobs.com/wday/cxs/acme/External/job/Austin/Intern_R1";
    const withdrawn = routes({
      [at]: { status: 403, body: { httpStatus: 403, errorCode: "S22" } },
    });
    expect((await checkPostingOpen(ref, opts(withdrawn.fn))).code).toBe("workday_api_withdrawn");
    const waf = routes({
      [at]: { status: 403, body: "<html>blocked</html>" },
      "https://acme.wd3.myworkdayjobs.com/en-US": { status: 403, body: "blocked" },
    });
    expect((await checkPostingOpen(ref, opts(waf.fn))).verdict).toBe("uncertain");
    const gone = routes({ [at]: { status: 404 } });
    expect((await checkPostingOpen(ref, opts(gone.fn))).verdict).toBe("expired");
  });

  it("SmartRecruiters: reads the active flag; a 404 alone decides nothing", async () => {
    const ref: LivenessRef = {
      ats: "smartrecruiters",
      boardToken: "Acme",
      atsJobId: "744000000",
      applyUrl: "https://jobs.smartrecruiters.com/Acme/744000000-data-intern",
    };
    const off = routes({
      "https://api.smartrecruiters.com/": { body: { id: "744000000", active: false } },
    });
    expect((await checkPostingOpen(ref, opts(off.fn))).verdict).toBe("expired");
    const unknown = routes({
      "https://api.smartrecruiters.com/": { status: 404 },
      "https://jobs.smartrecruiters.com/": { status: 200, body: "<div></div>" },
    });
    expect((await checkPostingOpen(ref, opts(unknown.fn))).verdict).toBe("uncertain");
  });

  it("a network failure is uncertain", async () => {
    const fn: FetchFn = async () => {
      throw new Error("offline");
    };
    expect((await checkPostingOpen(gh, opts(fn))).verdict).toBe("uncertain");
  });
});
