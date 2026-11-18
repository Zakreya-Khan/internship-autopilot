import { describe, expect, it, vi } from "vitest";
import { makeApi } from "../src/api.ts";
import type { NextResponse, SessionApi, SessionApplication, SessionState } from "../src/session.ts";
import { SessionController } from "../src/session.ts";

const app = (id: number): SessionApplication => ({
  id,
  applyUrl: `https://job-boards.greenhouse.io/exampleco/jobs/${id}`,
  ats: "greenhouse",
  company: "Example Co",
  title: `Intern ${id}`,
  fields: [{ key: "first_name", label: "First Name", type: "text", value: "Alex", required: true }],
  files: { resume: { name: "r.pdf", base64: "JVBERg==" } },
});

function harness(queue: number[]) {
  const pending = [...queue];
  const calls: string[] = [];
  const api: SessionApi = {
    next: vi.fn(async (skip: number[]): Promise<NextResponse> => {
      const id = pending.find((x) => !skip.includes(x));
      return id === undefined
        ? { done: true, remaining: 0 }
        : { done: false, remaining: pending.length, application: app(id) };
    }),
    filled: vi.fn(async (id: number) => {
      calls.push(`filled:${id}`);
      return { mismatches: [] };
    }),
    submitted: vi.fn(async (id: number, body) => {
      calls.push(`submitted:${id}:${body.detectedBy}`);
      pending.splice(pending.indexOf(id), 1);
    }),
    abandon: vi.fn(async (id: number) => void calls.push(`abandon:${id}`)),
  };
  const states: SessionState[] = [];
  const openTab = vi.fn(async (_url: string, reuse: number | null) => reuse ?? 7);
  const c = new SessionController({ api, openTab, onChange: (s) => states.push(s) });
  return { c, api, calls, openTab, states };
}

describe("SessionController", () => {
  it("fills, waits for you, and advances only after the confirmation page", async () => {
    const { c, calls, openTab } = harness([1, 2]);
    await c.start();
    expect(c.get()).toMatchObject({ phase: "filling", tabId: 7, application: { id: 1 } });
    expect(c.get().application).not.toHaveProperty("files");
    expect(c.jobForTab(7)).toMatchObject({ mode: "fill", application: { id: 1 } });
    expect(c.jobForTab(99)).toBeNull();

    await c.onFilled(7, [{ key: "first_name", status: "filled", seen: "Alex" }], "<form/>");
    expect(c.get().phase).toBe("waiting_for_you");
    expect(c.jobForTab(7)).toEqual({ mode: "watch", applicationId: 1 });

    await c.onConfirmed(7, "https://job-boards.greenhouse.io/exampleco/jobs/1/confirmation");
    expect(calls).toEqual(["filled:1", "submitted:1:confirmation_page"]);
    expect(c.get()).toMatchObject({ phase: "filling", application: { id: 2 }, submittedCount: 1 });
    expect(openTab).toHaveBeenLastCalledWith(expect.stringContaining("/jobs/2"), 7);
  });

  it("ignores a confirmation before the form was filled", async () => {
    const { c, calls } = harness([1]);
    await c.start();
    await c.onConfirmed(7, "x");
    expect(calls).toEqual([]);
    expect(c.get().phase).toBe("filling");
  });

  it("lets you confirm by hand, skip, and end", async () => {
    const { c, calls } = harness([1, 2, 3]);
    await c.start();
    await c.onFilled(7, [], null);
    await c.confirmByUser();
    expect(calls).toContain("submitted:1:user");

    await c.onFilled(7, [], null);
    await c.skip();
    expect(calls).toContain("abandon:2");
    expect(c.get()).toMatchObject({ application: { id: 3 }, skip: [2] });

    await c.end();
    expect(c.get()).toMatchObject({ phase: "idle", submittedCount: 1 });
  });

  it("reports when the queue is empty or the server is down", async () => {
    const { c } = harness([]);
    await c.start();
    expect(c.get()).toMatchObject({ phase: "done" });
    const broken = new SessionController({
      api: { ...harness([]).api, next: async () => Promise.reject(new Error("ECONNREFUSED")) },
      openTab: async () => 1,
      onChange: () => {},
    });
    await broken.start();
    expect(broken.get().phase).toBe("error");
    expect(broken.get().message).toMatch(/local server/);
  });
});

describe("extension API client", () => {
  it("sends the token and refuses to run without one", async () => {
    const fetchFn = vi.fn(async () => Response.json({ done: true, remaining: 0 }));
    const api = makeApi(
      async () => ({ baseUrl: "http://127.0.0.1:4317", token: "t" }),
      fetchFn as unknown as typeof fetch,
    );
    await api.next([3]);
    expect(fetchFn).toHaveBeenCalledWith(
      "http://127.0.0.1:4317/api/session/next",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-ia-token": "t" }),
        body: '{"skip":[3]}',
      }),
    );
    const noToken = makeApi(
      async () => ({ baseUrl: "http://127.0.0.1:4317", token: "" }),
      fetchFn as unknown as typeof fetch,
    );
    await expect(noToken.next([])).rejects.toThrow(/token/);
  });
});
