import { describe, expect, it, vi } from "vitest";
import {
  fetchAshbyBoard,
  fetchGreenhouseBoard,
  fetchGreenhouseQuestions,
  fetchLeverSite,
  fetchSimplify,
  getJson,
  HostRateLimiter,
  HttpError,
  pollSources,
  USER_AGENT,
} from "../src/index.ts";
import type { FetchFn } from "../src/index.ts";

/** A fetch that answers from a URL → body table, recording every call. */
function fakeFetch(routes: Record<string, unknown | (() => Response)>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return new Response("not found", { status: 404 });
    const v = routes[key];
    return typeof v === "function" ? (v as () => Response)() : Response.json(v);
  };
  return { fn, calls };
}

const noWait = async () => {};

describe("getJson", () => {
  it("retries 503 with backoff, then succeeds", async () => {
    let n = 0;
    const { fn } = fakeFetch({
      "https://x.test/a": () =>
        ++n < 3 ? new Response("busy", { status: 503 }) : Response.json({ ok: 1 }),
    });
    const waits: number[] = [];
    const data = await getJson("https://x.test/a", {
      fetch: fn,
      wait: async (ms) => void waits.push(ms),
    });
    expect(data).toEqual({ ok: 1 });
    expect(waits).toEqual([2000, 4000]);
  });

  it("does not retry a 404", async () => {
    const { fn, calls } = fakeFetch({});
    await expect(
      getJson("https://x.test/missing", { fetch: fn, wait: noWait }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(calls).toHaveLength(1);
  });

  it("sends a generic user agent, nothing personal", async () => {
    const { fn, calls } = fakeFetch({ "https://x.test/": { a: 1 } });
    await getJson("https://x.test/", { fetch: fn });
    expect(new Headers(calls[0]!.init?.headers).get("User-Agent")).toBe(USER_AGENT);
  });
});

describe("HostRateLimiter", () => {
  it("spaces requests to one host and leaves other hosts alone", async () => {
    let t = 0;
    const waited: number[] = [];
    const lim = new HostRateLimiter(
      1000,
      () => t,
      async (ms) => {
        waited.push(ms);
      },
    );
    await lim.acquire("https://a.test/1");
    await lim.acquire("https://a.test/2");
    await lim.acquire("https://b.test/1");
    t = 5000;
    await lim.acquire("https://a.test/3");
    expect(waited).toEqual([1000]);
  });
});

describe("Simplify list", () => {
  it("maps rows, drops hidden ones, keeps inactive as closed", async () => {
    const { fn } = fakeFetch({
      "https://raw.githubusercontent.com/": [
        {
          id: "1",
          company_name: "Example Co",
          title: "Software Engineer Intern",
          url: "https://job-boards.greenhouse.io/exampleco/jobs/42?utm_source=Simplify",
          locations: ["Seattle, WA"],
          terms: ["Summer 2027"],
          active: true,
          is_visible: true,
          sponsorship: "Does Not Offer Sponsorship",
          degrees: ["Bachelor's"],
          category: "Software",
          date_posted: 1794000000,
        },
        { id: "2", company_name: "Hidden", title: "x", url: "https://x.test", is_visible: false },
        {
          id: "3",
          company_name: "Old Co",
          title: "Intern",
          url: "https://jobs.lever.co/old/abc",
          active: false,
        },
        { bogus: true },
      ],
    });
    const rows = await fetchSimplify({ fetch: fn });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      ats: "greenhouse",
      boardToken: "exampleco",
      atsJobId: "42",
      sponsorship: "no_sponsorship",
      sources: ["simplify"],
      postedAt: new Date(1794000000 * 1000).toISOString(),
    });
    expect(rows[1]).toMatchObject({ ats: "lever", isOpen: false });
  });
});

describe("Greenhouse", () => {
  const board = {
    jobs: [
      {
        id: 7,
        title: "Software Engineering Intern (Summer 2027)",
        absolute_url: "https://job-boards.greenhouse.io/exampleco/jobs/7",
        location: { name: "San Francisco, CA; New York, NY" },
        content: "&lt;p&gt;Know Python. We don&#39;t offer visa sponsorship.&lt;/p&gt;",
        company_name: "Example Co",
        first_published: "2026-10-01T00:00:00Z",
        application_deadline: "2026-12-15T00:00:00Z",
      },
      {
        id: 8,
        title: "Senior Engineer",
        absolute_url: "https://job-boards.greenhouse.io/exampleco/jobs/8",
      },
    ],
  };

  it("keeps internships and decodes escaped HTML descriptions", async () => {
    const { fn } = fakeFetch({
      "https://boards-api.greenhouse.io/v1/boards/exampleco/jobs?": board,
    });
    const rows = await fetchGreenhouseBoard("exampleco", "Fallback", { fetch: fn });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      company: "Example Co",
      locations: ["San Francisco, CA", "New York, NY"],
      terms: ["Summer 2027"],
      deadline: "2026-12-15",
      sponsorship: "no_sponsorship",
    });
    expect(rows[0]!.descriptionText).toBe("Know Python. We don't offer visa sponsorship.");
  });

  it("maps form questions, including EEO and demographic blocks", async () => {
    const { fn } = fakeFetch({
      "https://boards-api.greenhouse.io/v1/boards/exampleco/jobs/7?questions=true": {
        ...board.jobs[0],
        questions: [
          {
            label: "First Name",
            required: true,
            fields: [{ name: "first_name", type: "input_text", values: [] }],
          },
          {
            label: "Resume/CV",
            required: true,
            fields: [
              { name: "resume", type: "input_file" },
              { name: "resume_text", type: "textarea" },
            ],
          },
          {
            label: "Will you require sponsorship?",
            required: true,
            fields: [
              {
                name: "question_1",
                type: "multi_value_single_select",
                values: [
                  { label: "Yes", value: 1 },
                  { label: "No", value: 0 },
                ],
              },
            ],
          },
          { label: "x", fields: [{ name: "hidden", type: "input_hidden" }] },
        ],
        compliance: [
          {
            type: "eeoc",
            questions: [
              {
                label: "Gender",
                required: false,
                fields: [
                  {
                    name: "gender",
                    type: "multi_value_single_select",
                    values: [{ label: "Decline", value: 3 }],
                  },
                ],
              },
            ],
          },
        ],
        demographic_questions: {
          questions: [
            {
              id: 99,
              label: "Pronouns",
              type: "multi_value_multi_select",
              answer_options: [{ label: "they/them" }],
            },
          ],
        },
      },
    });
    const qs = await fetchGreenhouseQuestions("exampleco", "7", { fetch: fn });
    expect(qs.map((q) => q.key)).toEqual([
      "first_name",
      "resume",
      "resume_text",
      "question_1",
      "eeo:gender",
      "demographic:99",
    ]);
    expect(qs.find((q) => q.key === "question_1")).toMatchObject({
      type: "select",
      options: ["Yes", "No"],
      required: true,
    });
    expect(qs.find((q) => q.key === "demographic:99")?.type).toBe("multi_select");
  });
});

describe("Lever and Ashby", () => {
  it("maps Lever postings with lists and remote workplace", async () => {
    const { fn } = fakeFetch({
      "https://api.lever.co/v0/postings/acme": [
        {
          id: "abc",
          text: "Data Science Intern - Summer 2027",
          hostedUrl: "https://jobs.lever.co/acme/abc",
          applyUrl: "https://jobs.lever.co/acme/abc/apply",
          createdAt: 1793000000000,
          categories: { location: "Seattle", allLocations: ["Seattle"], team: "Data" },
          descriptionPlain: "Join us.",
          lists: [{ text: "Requirements", content: "<li>SQL</li><li>Python</li>" }],
          workplaceType: "remote",
        },
        { id: "zzz", text: "Staff Engineer", hostedUrl: "https://jobs.lever.co/acme/zzz" },
      ],
    });
    const rows = await fetchLeverSite("acme", "Acme", { fetch: fn });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      locations: ["Seattle", "Remote"],
      atsJobId: "abc",
      terms: ["Summer 2027"],
    });
    expect(rows[0]!.descriptionText).toContain("- SQL");
  });

  it("maps Ashby jobs by employment type and drops unlisted ones", async () => {
    const { fn } = fakeFetch({
      "https://api.ashbyhq.com/posting-api/job-board/acme": {
        jobs: [
          {
            id: "j1",
            title: "Engineering (2027)",
            employmentType: "Intern",
            location: "New York",
            jobUrl: "https://jobs.ashbyhq.com/acme/j1",
            isListed: true,
            descriptionPlain: "TypeScript",
          },
          {
            id: "j2",
            title: "Software Intern",
            employmentType: "Intern",
            jobUrl: "https://jobs.ashbyhq.com/acme/j2",
            isListed: false,
          },
          {
            id: "j3",
            title: "Engineer",
            employmentType: "FullTime",
            jobUrl: "https://jobs.ashbyhq.com/acme/j3",
          },
        ],
      },
    });
    const rows = await fetchAshbyBoard("acme", "Acme", { fetch: fn });
    expect(rows.map((r) => r.atsJobId)).toEqual(["j1"]);
    expect(rows[0]!.applyUrl).toBe("https://jobs.ashbyhq.com/acme/j1/application");
  });
});

describe("pollSources", () => {
  it("isolates a failing board", async () => {
    const { fn } = fakeFetch({ "https://api.lever.co/v0/postings/good": [] });
    const res = await pollSources({
      fetch: fn,
      includeSimplify: false,
      limiter: new HostRateLimiter(0),
      watchlist: [
        { company: "Bad", ats: "greenhouse", token: "bad" },
        { company: "Good", ats: "lever", token: "good" },
      ],
    });
    expect(res.boards.map((b) => [b.board, b.error === null])).toEqual([
      ["greenhouse:bad", false],
      ["lever:good", true],
    ]);
  });

  it("does not call the network for Simplify when disabled", async () => {
    const spy = vi.fn<FetchFn>();
    await pollSources({ fetch: spy, watchlist: [], includeSimplify: false });
    expect(spy).not.toHaveBeenCalled();
  });
});
