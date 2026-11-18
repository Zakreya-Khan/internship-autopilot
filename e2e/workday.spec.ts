// Real Chromium: the Workday wizard fills each step, opens a delayed custom listbox, presses only
// "Save and Continue", and stops on Review with Submit outlined and never pressed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import type * as Adapters from "@ia/adapters";

test("Workday wizard stops on Review without submitting", async ({ page }) => {
  const out = await build({
    stdin: { contents: 'export * from "@ia/adapters";', resolveDir: process.cwd(), loader: "ts" },
    bundle: true,
    format: "iife",
    globalName: "IA",
    write: false,
  });
  await page.setContent(readFileSync(join(process.cwd(), "fixtures/forms/workday.html"), "utf8"));
  await page.addScriptTag({ content: out.outputFiles[0]!.text });
  const outcome = await page.evaluate(async () => {
    const IA = (window as unknown as { IA: typeof Adapters }).IA;
    const fields = [
      { key: "first_name", label: "First Name", type: "text", value: "Alex", required: true },
      { key: "email", label: "Email", type: "text", value: "alex@example.com", required: true },
      {
        key: "how_heard",
        label: "How Did You Hear About Us?",
        type: "select",
        value: "Job Board",
        required: true,
      },
      {
        key: "resume",
        label: "Resume/CV",
        type: "file",
        value: null,
        required: true,
        attach: "resume" as const,
      },
    ];
    const files = {
      resume: new File([new Uint8Array([37, 80, 68, 70])], "Resume.pdf", {
        type: "application/pdf",
      }),
    };
    return IA.runWizard(IA.workday, document, fields, files, { settleMs: 50, stepTimeoutMs: 5000 });
  });
  expect(outcome.stoppedAt).toBe("review");
  expect(outcome.steps).toBe(3);
  expect(outcome.results.every((r: { status: string }) => r.status === "filled")).toBe(true);
  const values = await page.evaluate(
    () => (window as unknown as { __values: Record<string, string> }).__values,
  );
  expect(values).toMatchObject({ fn: "Alex", em: "alex@example.com", src: "Job Board" });
  await expect(page.locator("[data-automation-id=pageFooterSubmitButton]")).toHaveAttribute(
    "data-ia-highlight",
    "submit",
  );
  expect(
    await page.evaluate(() => (window as unknown as { __submitClicks: number }).__submitClicks),
  ).toBe(0);
});
