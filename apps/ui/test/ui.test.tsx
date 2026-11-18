// @vitest-environment happy-dom
import type { ResumeDiff } from "@ia/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Field } from "../src/api.ts";
import { parseRoute } from "../src/App.tsx";
import { FieldsTable } from "../src/components/FieldsTable.tsx";
import { ResumeDiffView } from "../src/components/ResumeDiffView.tsx";

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
    expect(parseRoute("")).toEqual({ page: "queue" });
  });
});
