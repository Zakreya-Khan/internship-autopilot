import { describe, expect, it } from "vitest";
import {
  fetchPostingDetail,
  fetchSmartRecruitersBoard,
  fetchWorkdayBoard,
  HostRateLimiter,
  parseWorkdayPostedOn,
  parseWorkdayUrl,
  pollSources,
  workdayDetailUrl,
} from "../src/index.ts";
import type { FetchFn } from "../src/index.ts";

const NOW = new Date("2026-11-18T15:00:00Z");
const http = (fetch: FetchFn) => ({ fetch, limiter: new HostRateLimiter(0), wait: async () => {} });

function recorder(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn: FetchFn = async (url, init) => {
    calls.push({ url, ...(init ? { init } : {}) });
    return handler(url, init);
  };
  return { fn, calls };
}

describe("parseWorkdayUrl", () => {
  it("reads tenant, instance host and site, skipping a locale", () => {
    expect(
      parseWorkdayUrl("https://ExampleCo.wd5.myworkdayjobs.com/en-US/Careers/job/X_JR1"),
    ).toEqual({
      host: "exampleco.wd5.myworkdayjobs.com",
      tenant: "exampleco",
      site: "Careers",
      origin: "https://exampleco.wd5.myworkdayjobs.com/Careers",
    });
    expect(parseWorkdayUrl("https://acme.wd1.myworkdayjobs.com/External")?.site).toBe("External");
  });

  it("accepts myworkdaysite.com recruiting URLs and rejects others", () => {
    expect(parseWorkdayUrl("https://wd3.myworkdaysite.com/recruiting/acme/Students")?.origin).toBe(
      "https://wd3.myworkdaysite.com/recruiting/acme/Students",
    );
    expect(parseWorkdayUrl("https://example.com/careers")).toBeNull();
    expect(parseWorkdayUrl("https://acme.wd1.myworkdayjobs.com/")).toBeNull();
  });
});

describe("parseWorkdayPostedOn", () => {
  it("turns relative labels into dates", () => {
    expect(parseWorkdayPostedOn("Posted Today", NOW)).toBe("2026-11-18T00:00:00.000Z");
    expect(parseWorkdayPostedOn("Posted Yesterday", NOW)).toBe("2026-11-17T00:00:00.000Z");
    expect(parseWorkdayPostedOn("Posted 5 Days Ago", NOW)).toBe("2026-11-13T00:00:00.000Z");
    expect(parseWorkdayPostedOn("posted  1 day ago", NOW)).toBe("2026-11-17T00:00:00.000Z");
  });

  it("leaves 30+ and unknown labels empty", () => {
    expect(parseWorkdayPostedOn("Posted 30+ Days Ago", NOW)).toBeNull();
    expect(parseWorkdayPostedOn("Recently", NOW)).toBeNull();
    expect(parseWorkdayPostedOn(undefined, NOW)).toBeNull();
  });
});

describe("fetchWorkdayBoard", () => {
  const page = (offset: number, total: number, n: number) => ({
    total: offset === 0 ? total : 0,
    jobPostings: Array.from({ length: n }, (_, i) => ({
      title:
        i % 2 === 0 ? `Software Engineer Intern ${offset + i}` : `Senior Engineer ${offset + i}`,
      externalPath: `/job/Santa-Clara-CA/Role-${offset + i}_JR${1000 + offset + i}`,
      locationsText: i === 0 ? "3 Locations" : "Santa Clara, CA",
      postedOn: "Posted 2 Days Ago",
    })),
  });

  it("POSTs the search, pages until the total, and maps internships only", async () => {
    const { fn, calls } = recorder((_url, init) => {
      const body = JSON.parse(String(init?.body)) as { offset: number };
      return Response.json(page(body.offset, 25, body.offset === 0 ? 20 : 5));
    });
    const rows = await fetchWorkdayBoard(
      "https://exampleco.wd5.myworkdayjobs.com/en-US/Careers",
      "Example Co",
      http(fn),
      NOW,
      ["intern"],
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe(
      "https://exampleco.wd5.myworkdayjobs.com/wday/cxs/exampleco/Careers/jobs",
    );
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      appliedFacets: {},
      limit: 20,
      offset: 0,
      searchText: "intern",
    });
    expect(rows).toHaveLength(13);
    const first = rows[0]!;
    expect(first).toMatchObject({
      ats: "workday",
      boardToken: "exampleco",
      atsJobId: "JR1000",
      applyUrl: "https://exampleco.wd5.myworkdayjobs.com/Careers/job/Santa-Clara-CA/Role-0_JR1000",
      locations: [],
      sources: ["workday"],
      postedAt: "2026-11-16T00:00:00.000Z",
    });
    expect(rows[1]!.locations).toEqual(["Santa Clara, CA"]);
  });

  it("searches each term, stops at a page with no internships, and dedupes across terms", async () => {
    const { fn, calls } = recorder((_url, init) => {
      const body = JSON.parse(String(init?.body)) as { offset: number; searchText: string };
      const titles =
        body.offset === 0 ? ["Software Intern", "Data Intern"] : ["International Tax Lead"];
      return Response.json({
        total: body.offset === 0 ? 100 : 0,
        jobPostings: Array.from({ length: 20 }, (_, i) => ({
          title: titles[i % titles.length],
          externalPath: `/job/X/${titles[i % titles.length]!.replace(/ /g, "-")}_JR${body.offset + i}`,
        })),
      });
    });
    const rows = await fetchWorkdayBoard(
      "https://exampleco.wd5.myworkdayjobs.com/Careers",
      "Example Co",
      http(fn),
      NOW,
    );
    // Two terms, two pages each: page 2 has no internships, so paging stops there.
    expect(calls.map((c) => JSON.parse(String(c.init?.body)).searchText)).toEqual([
      "intern",
      "intern",
      "internship",
      "internship",
    ]);
    expect(rows).toHaveLength(20);
  });

  it("stops on a short page even without a total", async () => {
    const { fn, calls } = recorder(() => Response.json({ jobPostings: [] }));
    expect(
      await fetchWorkdayBoard("https://a.wd1.myworkdayjobs.com/Ext", "A", http(fn), NOW, [
        "intern",
      ]),
    ).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("rejects a URL that isn't a Workday site", async () => {
    const { fn } = recorder(() => Response.json({}));
    await expect(fetchWorkdayBoard("https://example.com/jobs", "A", http(fn), NOW)).rejects.toThrow(
      /Not a Workday/,
    );
  });
});

describe("Workday details", () => {
  it("builds the detail URL from a job link and reads description and locations", async () => {
    const link =
      "https://exampleco.wd5.myworkdayjobs.com/en-US/Careers/job/Santa-Clara-CA/Intern_JR7/apply";
    expect(workdayDetailUrl(link)).toBe(
      "https://exampleco.wd5.myworkdayjobs.com/wday/cxs/exampleco/Careers/job/Santa-Clara-CA/Intern_JR7",
    );
    const { fn } = recorder(() =>
      Response.json({
        jobPostingInfo: {
          jobDescription: "<p>Python and SQL. Summer 2027.</p>",
          location: "Santa Clara, CA",
          additionalLocations: ["Austin, TX"],
          canApply: true,
        },
      }),
    );
    const d = await fetchPostingDetail(
      { ats: "workday", boardToken: "exampleco", atsJobId: "JR7", applyUrl: link },
      http(fn),
    );
    expect(d).toMatchObject({
      descriptionText: "Python and SQL. Summer 2027.",
      locations: ["Santa Clara, CA", "Austin, TX"],
    });
  });
});

describe("fetchSmartRecruitersBoard", () => {
  it("pages through postings and keeps internships", async () => {
    const { fn, calls } = recorder((url) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      const n = offset === 0 ? 100 : 3;
      return Response.json({
        totalFound: 103,
        content: Array.from({ length: n }, (_, i) => ({
          id: String(744000000 + offset + i),
          name: i === 0 ? "Data Science Intern" : "Account Executive",
          releasedDate: "2026-11-10T10:00:00.000Z",
          location: { city: "Austin", region: "TX", country: "us", remote: i === 0 },
          typeOfEmployment: { label: i === 1 ? "Internship" : "Full-time" },
        })),
      });
    });
    const rows = await fetchSmartRecruitersBoard("ExampleCo", "Example Co", http(fn));
    expect(calls.map((c) => new URL(c.url).searchParams.get("offset"))).toEqual(["0", "100"]);
    expect(rows.map((r) => r.title)).toEqual([
      "Data Science Intern",
      "Account Executive",
      "Data Science Intern",
      "Account Executive",
    ]);
    expect(rows[0]).toMatchObject({
      ats: "smartrecruiters",
      boardToken: "ExampleCo",
      atsJobId: "744000000",
      applyUrl: "https://jobs.smartrecruiters.com/ExampleCo/744000000",
      locations: ["Austin, TX, US", "Remote"],
    });
  });
});

describe("pollSources with Workday", () => {
  it("polls a Workday site from its URL and knows which postings it owns", async () => {
    const { fn } = recorder(() =>
      Response.json({
        total: 1,
        jobPostings: [{ title: "Software Intern", externalPath: "/job/X/Software-Intern_JR9" }],
      }),
    );
    const res = await pollSources({
      fetch: fn,
      includeSimplify: false,
      limiter: new HostRateLimiter(0),
      now: NOW,
      watchlist: [
        {
          company: "Example Co",
          ats: "workday",
          url: "https://exampleco.wd5.myworkdayjobs.com/Careers",
        },
      ],
    });
    const b = res.boards[0]!;
    expect(b.board).toBe("workday:exampleco/Careers");
    expect(b.postings).toHaveLength(1);
    expect(
      b.owns({
        ats: "workday",
        boardToken: "exampleco",
        applyUrl: "https://exampleco.wd5.myworkdayjobs.com/en-US/Careers/job/Y_JR2",
      }),
    ).toBe(true);
    expect(
      b.owns({
        ats: "workday",
        boardToken: "exampleco",
        applyUrl: "https://exampleco.wd5.myworkdayjobs.com/Other/job/Y_JR2",
      }),
    ).toBe(false);
  });
});

describe("Ashby slugs with spaces", () => {
  it("are encoded once", async () => {
    const { fn, calls } = recorder(() =>
      Response.json({ jobs: [{ id: "j1", descriptionPlain: "x" }] }),
    );
    await fetchPostingDetail(
      { ats: "ashby", boardToken: "latent%20labs", atsJobId: "j1" },
      http(fn),
    );
    expect(calls[0]!.url).toBe("https://api.ashbyhq.com/posting-api/job-board/latent%20labs");
  });
});
