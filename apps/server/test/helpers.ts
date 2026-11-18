import type { FetchFn } from "@ia/sources";
import { Store } from "../src/db.ts";

export function memoryStore(start = "2026-11-17T12:00:00.000Z"): Store {
  let t = Date.parse(start);
  // Each read of the clock moves it forward 1 ms, so event order is stable.
  return new Store(":memory:", () => new Date(t++).toISOString());
}

export function routeFetch(routes: Record<string, unknown>): FetchFn {
  return async (url) => {
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    return key ? Response.json(routes[key]) : new Response("nope", { status: 404 });
  };
}

export const SIMPLIFY_URL = "https://raw.githubusercontent.com/SimplifyJobs/";

export function simplifyRow(over: Record<string, unknown> = {}) {
  return {
    id: "s1",
    company_name: "Example Co",
    title: "Software Engineer Intern",
    url: "https://job-boards.greenhouse.io/exampleco/jobs/501",
    locations: ["San Francisco, CA"],
    terms: ["Summer 2027"],
    active: true,
    is_visible: true,
    sponsorship: "Other",
    degrees: ["Bachelor's"],
    category: "Software",
    date_posted: 1794500000,
    ...over,
  };
}

export function greenhouseBoard(jobs: { id: number; title: string; content?: string }[]) {
  return {
    jobs: jobs.map((j) => ({
      id: j.id,
      title: j.title,
      absolute_url: `https://job-boards.greenhouse.io/exampleco/jobs/${j.id}`,
      location: { name: "San Francisco, CA" },
      content: j.content ?? "&lt;p&gt;Python and TypeScript.&lt;/p&gt;",
      company_name: "Example Co",
      first_published: "2026-11-10T00:00:00Z",
    })),
  };
}
