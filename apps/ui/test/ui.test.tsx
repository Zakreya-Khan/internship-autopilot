// @vitest-environment happy-dom
import type { ResumeDiff } from "@ia/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Field, QualifyItem } from "../src/api.ts";
import { api } from "../src/api.ts";
import { parseRoute } from "../src/App.tsx";
import { FieldsTable } from "../src/components/FieldsTable.tsx";
import { ResumeDiffView } from "../src/components/ResumeDiffView.tsx";
import { Qualify } from "../src/pages/Qualify.tsx";

vi.mock("../src/api.ts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: { qualify: vi.fn() },
}));

afterEach(cleanup);

const diff: ResumeDiff = {
  bullets: [
    {
      status: "reworded",
      entryId: "exp.lab",
      factIds: ["exp.lab.f1"],
      base: "Built a pipeline",
      variant: "Built a Python pipeline",
      words: [{ value: "Built a " }, { value: "Python ", added: true }, { value: "pipeline" }],
      moved: -1,
    },
    {
      status: "removed",
      entryId: "proj.app",
      factIds: ["proj.app.f1"],
      base: "Wrote an app",
      variant: null,
      words: null,
      moved: 0,
    },
  ],
  skillsMoved: [{ skill: "python", from: 2, to: 0 }],
  skillsDropped: ["go"],
  entriesDropped: ["proj.app"],
  summary: { kept: 0, reworded: 1, added: 0, removed: 1 },
};

const field = (over: Partial<Field>): Field => ({
  field_key: "k",
  label: "Label",
  field_type: "text",
  planned_value: null,
  source: "profile",
  confidence: "high",
  flag: null,
  note: null,
  required: false,
  options: null,
  attach: null,
  value_seen: null,
  ...over,
});

describe("ResumeDiffView", () => {
  it("shows word-level insertions, moves, removals and cited facts", () => {
    const { container } = render(<ResumeDiffView diff={diff} />);
    expect(container.querySelector("ins")?.textContent).toBe("Python ");
    expect(screen.getByText(/Reworded · moved up 1/)).toBeTruthy();
    expect(screen.getByText("exp.lab.f1")).toBeTruthy();
    expect(screen.getByText(/python up · dropped go/)).toBeTruthy();
  });
});

describe("FieldsTable", () => {
  it("lists red flags first and lets you answer them", async () => {
    const onSave = vi.fn(async () => {});
    render(
      <FieldsTable
        editable
        onSave={onSave}
        fields={[
          field({ field_key: "first_name", label: "First Name", planned_value: "Alex" }),
          field({
            field_key: "q3",
            label: "Know anyone here?",
            flag: "red",
            options: ["Yes", "No"],
            required: true,
            note: "Needs you.",
          }),
          field({ field_key: "resume", label: "Resume", attach: "resume" }),
        ]}
      />,
    );
    const rows = screen.getAllByRole("row");
    expect(rows[1]!.textContent).toContain("Know anyone here?");
    expect(screen.getByText("Attaches your resume")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Know anyone here?"), { target: { value: "No" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith("q3", "No"));
  });

  it("shows what the page actually held when it differs", () => {
    render(
      <FieldsTable
        editable={false}
        onSave={async () => {}}
        fields={[field({ label: "Email", planned_value: "a@b.c", value_seen: "typo@b.c" })]}
      />,
    );
    expect(screen.getByText("Page showed: typo@b.c")).toBeTruthy();
  });
});

describe("routing", () => {
  it("parses hash routes", () => {
    expect(parseRoute("#/app/12")).toEqual({ page: "detail", id: 12 });
    expect(parseRoute("#/tracker")).toEqual({ page: "tracker" });
    expect(parseRoute("#/qualify")).toEqual({ page: "qualify" });
    expect(parseRoute("")).toEqual({ page: "queue" });
  });
});

describe("Qualify page", () => {
  const item: QualifyItem = {
    postingId: "p1",
    company: "Close Co",
    title: "Data Intern",
    applyUrl: "https://example.test/apply",
    locations: [],
    tier: "A",
    score: 82,
    applicationId: null,
    qualification: {
      verdict: "close",
      checks: [
        { kind: "gpa", need: "GPA of 3.9 or higher", have: "GPA 3.70", met: false },
        {
          kind: "degree",
          need: "pursuing a bachelor's degree",
          have: "bachelor's degree",
          met: true,
        },
      ],
      notes: ["The posting says it doesn't sponsor visas. Check that against your situation."],
    },
  };

  it("shows each requirement, which one is short, and what the posting says about visas", async () => {
    vi.mocked(api.qualify).mockResolvedValue([item]);
    render(<Qualify />);
    await waitFor(() => expect(screen.getByText("Close Co")).toBeTruthy());
    expect(api.qualify).toHaveBeenCalledWith("meets");
    expect(screen.getByText("Short")).toBeTruthy();
    expect(screen.getByText("GPA of 3.9 or higher")).toBeTruthy();
    expect(screen.getByText(/doesn't sponsor visas/)).toBeTruthy();
    // Not prepared yet, so the title links out to the posting.
    expect(screen.getByRole("link", { name: "Data Intern" }).getAttribute("href")).toBe(
      "https://example.test/apply",
    );
  });

  it("asks for the one-short list when switched", async () => {
    vi.mocked(api.qualify).mockResolvedValue([]);
    render(<Qualify />);
    await waitFor(() => expect(screen.getByText(/Nothing here yet/)).toBeTruthy());
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "close" } });
    await waitFor(() => expect(api.qualify).toHaveBeenLastCalledWith("close"));
  });
});
