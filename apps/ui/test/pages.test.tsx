// @vitest-environment happy-dom
// The pages that replace the command line: Home, Discover, Queue shortcuts, jobs and Open & fill.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobView, PostingSearch, QueueItem, Summary } from "../src/api.ts";
import { api } from "../src/api.ts";
import { JobStatus } from "../src/components/Jobs.tsx";
import { OpenFill } from "../src/components/OpenFill.tsx";
import { Discover } from "../src/pages/Discover.tsx";
import { Home } from "../src/pages/Home.tsx";
import { Queue } from "../src/pages/Queue.tsx";

vi.mock("../src/api.ts", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    api: {
      summary: vi.fn(),
      queue: vi.fn(),
      providerSettings: vi.fn(),
      postings: vi.fn(),
      skipPostings: vi.fn(),
      jobs: vi.fn(async () => []),
      job: vi.fn(),
      startJob: vi.fn(),
      cancelJob: vi.fn(),
      setStatus: vi.fn(async () => ({ ok: true })),
      launch: vi.fn(),
    },
  };
});

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api.jobs).mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const summary = (over: Partial<Summary> = {}): Summary => ({
  applications: {},
  needsInput: 0,
  ready: 0,
  approved: 0,
  filled: 0,
  sent: 0,
  postings: { open: 120, passed: 40, unstarted: 30, unstartedAB: 12 },
  lastRefresh: null,
  openBatches: 0,
  dueSoon: 0,
  questions: 0,
  jobs: [],
  autorun: true,
  ...over,
});

const job = (over: Partial<JobView> = {}): JobView => ({
  id: 1,
  kind: "prep",
  label: "Prepare applications",
  status: "running",
  startedAt: new Date().toISOString(),
  finishedAt: null,
  progress: { done: 2, total: 5, note: "Example Co: Intern" },
  log: [],
  summary: null,
  result: null,
  error: null,
  ...over,
});

const item = (id: number, status: QueueItem["status"]): QueueItem => ({
  id,
  status,
  tier: "A",
  score: 80,
  posting: {
    id: `p${id}`,
    company: `Co ${id}`,
    title: `Intern ${id}`,
    locations: [],
    ats: "greenhouse",
    applyUrl: `https://job-boards.greenhouse.io/co/jobs/${id}`,
    deadline: null,
    sponsorship: "unknown",
    sourceLinks: [],
  },
  flags: { red: 0, amber: 0, grey: 0 },
  updatedAt: "2026-11-17T00:00:00Z",
});

describe("Home", () => {
  it("lists what to do next, in order, with the action for each", async () => {
    vi.mocked(api.summary).mockResolvedValue(summary({ questions: 3, ready: 2, approved: 1 }));
    vi.mocked(api.queue).mockResolvedValue([item(9, "approved")]);
    vi.mocked(api.providerSettings).mockRejectedValue(new Error("x"));
    render(<Home />);
    const steps = await screen.findAllByRole("listitem");
    expect(steps[0]!.textContent).toMatch(/Answer 3 questions/);
    expect(steps[1]!.textContent).toMatch(/Approve 2 applications/);
    expect(await screen.findByRole("button", { name: "Open & fill" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Prepare the next 5" })).toBeTruthy();
  });

  it("starts with Find postings when there are none", async () => {
    vi.mocked(api.summary).mockResolvedValue(
      summary({ postings: { open: 0, passed: 0, unstarted: 0, unstartedAB: 0 } }),
    );
    vi.mocked(api.queue).mockResolvedValue([]);
    vi.mocked(api.providerSettings).mockRejectedValue(new Error("x"));
    vi.mocked(api.startJob).mockResolvedValue(job({ kind: "refresh", label: "Find postings" }));
    render(<Home />);
    expect(await screen.findByText("Start by finding postings")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Find postings" })[0]!);
    await waitFor(() => expect(api.startJob).toHaveBeenCalledWith("refresh", {}));
  });
});

describe("Discover", () => {
  const search: PostingSearch = {
    total: 2,
    offset: 0,
    items: [
      {
        id: "a",
        company: "Alpha Co",
        title: "SWE Intern",
        locations: ["Remote"],
        ats: "greenhouse",
        sources: ["simplify"],
        applyUrl: "https://job-boards.greenhouse.io/alpha/jobs/1",
        deadline: null,
        postedAt: null,
        firstSeen: "2026-11-01T00:00:00Z",
        isOpen: true,
        sponsorship: "unknown",
        hasDescription: true,
        tier: "A",
        score: 88,
        passed: true,
        filterReasons: [],
        application: null,
        liveness: null,
      },
      {
        id: "b",
        company: "Beta Co",
        title: "Data Intern",
        locations: [],
        ats: "lever",
        sources: ["lever"],
        applyUrl: "https://jobs.lever.co/beta/1",
        deadline: null,
        postedAt: null,
        firstSeen: "2026-11-01T00:00:00Z",
        isOpen: true,
        sponsorship: "unknown",
        hasDescription: false,
        tier: "B",
        score: 64,
        passed: true,
        filterReasons: [],
        application: { id: 4, status: "ready" },
        liveness: null,
      },
    ],
    sources: [{ name: "simplify", count: 2 }],
    counts: { all: 10, open: 8, passed: 2 },
  };

  it("filters on the server and prepares the postings you tick", async () => {
    vi.mocked(api.postings).mockResolvedValue(search);
    vi.mocked(api.startJob).mockResolvedValue(job());
    render(<Discover />);
    expect(await screen.findByText("Alpha Co")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Ready to approve" }).getAttribute("href")).toBe(
      "#/app/4",
    );
    fireEvent.change(screen.getByLabelText("Tier"), { target: { value: "A" } });
    await waitFor(() =>
      expect(api.postings).toHaveBeenLastCalledWith(expect.objectContaining({ tier: "A" })),
    );
    fireEvent.click(screen.getByLabelText("Select Alpha Co: SWE Intern"));
    fireEvent.click(screen.getByRole("button", { name: "Prepare 1" }));
    await waitFor(() => expect(api.startJob).toHaveBeenCalledWith("prep", { postingIds: ["a"] }));
    // The running job shows its progress.
    expect(await screen.findByText(/2 of 5/)).toBeTruthy();
  });

  it("offers Find postings when nothing has been found yet", async () => {
    vi.mocked(api.postings).mockResolvedValue({
      ...search,
      total: 0,
      items: [],
      counts: { all: 0, open: 0, passed: 0 },
    });
    render(<Discover />);
    expect(await screen.findByText("No postings yet")).toBeTruthy();
  });
});

describe("Queue shortcuts", () => {
  it("approves with a, skips with s, and ignores keys typed in a field", async () => {
    vi.mocked(api.queue).mockResolvedValue([item(1, "ready"), item(2, "needs_input")]);
    render(<Queue status={null} />);
    await screen.findByText("Co 1");
    fireEvent.keyDown(window, { key: "a" });
    await waitFor(() => expect(api.setStatus).toHaveBeenCalledWith(1, "approved"));
    const input = document.createElement("input");
    document.body.append(input);
    fireEvent.keyDown(input, { key: "s" });
    expect(api.setStatus).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "s" });
    await waitFor(() => expect(api.setStatus).toHaveBeenCalledWith(2, "skipped"));
  });
});

describe("JobStatus", () => {
  it("shows a summary when done and the error in words when it failed", () => {
    const { rerender } = render(
      <JobStatus job={job({ status: "done", summary: "Prepared 2: 1 ready." })} />,
    );
    expect(screen.getByRole("status").textContent).toMatch(/Prepared 2: 1 ready\./);
    rerender(<JobStatus job={job({ status: "failed", error: "That file doesn't exist." })} />);
    expect(screen.getByRole("alert").textContent).toBe("That file doesn't exist.");
  });
});

describe("Open & fill", () => {
  it("opens the page in a new tab with no handle back, and explains the handoff", async () => {
    const tab = { opener: {} as unknown, location: { href: "" }, close: vi.fn() };
    const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    vi.mocked(api.launch).mockResolvedValue({
      applyUrl: "https://job-boards.greenhouse.io/co/jobs/1",
      ats: "greenhouse",
    });
    render(<OpenFill id={1} company="Co 1" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open & fill" }));
    });
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(tab.opener).toBeNull();
    expect(tab.location.href).toBe("https://job-boards.greenhouse.io/co/jobs/1");
    expect(screen.getByRole("status").textContent).toMatch(/The extension fills the form there/);
    open.mockRestore();
  });

  it("offers a plain link when the browser blocks the new tab", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    vi.mocked(api.launch).mockResolvedValue({
      applyUrl: "https://careers.example.org/jobs/1",
      ats: "greenhouse",
    });
    render(<OpenFill id={1} company="Co 1" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open & fill" }));
    });
    const link = screen.getByRole("link", { name: "Open the application page" });
    expect(link.getAttribute("href")).toBe("https://careers.example.org/jobs/1");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(screen.getByRole("status").textContent).toMatch(/blocked the new tab/);
    expect(screen.getByRole("status").textContent).toMatch(/Fill this page/);
    open.mockRestore();
  });

  it("closes the blank tab and says why when it can't launch", async () => {
    const tab = { opener: {}, location: { href: "" }, close: vi.fn() };
    const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    vi.mocked(api.launch).mockRejectedValue(new Error("Approve it first: it's ready."));
    render(<OpenFill id={1} company="Co 1" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open & fill" }));
    });
    expect(tab.close).toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/Approve it first/);
    open.mockRestore();
  });
});

describe("auto-run from the review UI", () => {
  it("asks the extension to start on load and when more get approved, only with auto-run on", async () => {
    const { useExtension } = await import("../src/components/Extension.tsx");
    const asked: string[] = [];
    const post = vi.spyOn(window, "postMessage").mockImplementation((msg: unknown) => {
      asked.push((msg as { type: string }).type);
    });
    document.documentElement.dataset.iaExtension = "1";
    function Probe({ s }: { s: Summary }) {
      useExtension(s);
      return null;
    }
    const { rerender } = render(<Probe s={summary({ approved: 2 })} />);
    expect(asked.filter((x) => x === "autorun")).toHaveLength(1);
    rerender(<Probe s={summary({ approved: 2 })} />);
    rerender(<Probe s={summary({ approved: 1 })} />); // one was submitted: no new start
    expect(asked.filter((x) => x === "autorun")).toHaveLength(1);
    rerender(<Probe s={summary({ approved: 3 })} />); // you approved more
    expect(asked.filter((x) => x === "autorun")).toHaveLength(2);
    rerender(<Probe s={summary({ approved: 5, autorun: false })} />);
    expect(asked.filter((x) => x === "autorun")).toHaveLength(2);
    rerender(<Probe s={summary({ approved: 5, autorun: true })} />); // turned back on
    expect(asked.filter((x) => x === "autorun")).toHaveLength(3);
    post.mockRestore();
    delete document.documentElement.dataset.iaExtension;
  });

  it("never asks when nothing is approved", async () => {
    const { useExtension } = await import("../src/components/Extension.tsx");
    const asked: string[] = [];
    const post = vi.spyOn(window, "postMessage").mockImplementation((msg: unknown) => {
      asked.push((msg as { type: string }).type);
    });
    document.documentElement.dataset.iaExtension = "1";
    function Probe() {
      useExtension(summary({ approved: 0 }));
      return null;
    }
    render(<Probe />);
    expect(asked).not.toContain("autorun");
    post.mockRestore();
    delete document.documentElement.dataset.iaExtension;
  });
});
