// End to end in real Chromium: prep → approve → session payload → fill → the person presses Submit
// → confirmation detected → tracker. Fictional data only; no network, no model calls.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { FakeLlm } from "@ia/ai";
import type * as Adapters from "@ia/adapters";
import type { FormQuestion } from "@ia/core";
import { makePosting, testProfile } from "@ia/core/testing";
import { buildServer } from "../apps/server/src/api.ts";
import { Store } from "../apps/server/src/db.ts";
import { prepareOne } from "../apps/server/src/prep.ts";

const HOST = "127.0.0.1:4317";
const TOKEN = "e2e-token";
const FIXTURE = readFileSync(join(process.cwd(), "fixtures/forms/greenhouse.html"), "utf8");

const QUESTIONS: FormQuestion[] = [
  { key: "first_name", label: "First Name", required: true, type: "text" },
  { key: "last_name", label: "Last Name", required: true, type: "text" },
  { key: "email", label: "Email", required: true, type: "text" },
  { key: "phone", label: "Phone", required: false, type: "text" },
  { key: "resume", label: "Resume/CV", required: true, type: "file" },
  {
    key: "question_1",
    label: "Why do you want to work at Example Co?",
    required: true,
    type: "textarea",
  },
  {
    key: "question_2",
    label: "Will you require visa sponsorship?",
    required: true,
    type: "select",
    options: ["Yes", "No"],
  },
  {
    key: "eeo:gender",
    label: "Gender",
    required: false,
    type: "select",
    options: ["Male", "Female", "I don't wish to answer"],
  },
];

let bundle = "";
test.beforeAll(async () => {
  const out = await build({
    stdin: { contents: 'export * from "@ia/adapters";', resolveDir: process.cwd(), loader: "ts" },
    bundle: true,
    format: "iife",
    globalName: "IA",
    write: false,
  });
  bundle = out.outputFiles[0]!.text;
});

test("one application from approval to the tracker, with the person pressing Submit", async ({
  page,
}) => {
  const profile = testProfile();
  const store = new Store(":memory:");
  const outDir = mkdtempSync(join(tmpdir(), "ia-e2e-"));
  const posting = makePosting({ id: "greenhouse:exampleco:123", questions: QUESTIONS });
  store.savePostings([posting]);
  const llm = new FakeLlm({
    draft: () => ({
      resume: {
        entries: [
          {
            entry_id: "exp.lab",
            bullets: [
              {
                text: "Cut the nightly processing job from 6 hours to 40 minutes",
                fact_ids: ["exp.lab.f2"],
              },
            ],
          },
        ],
        skills_order: ["python"],
        courses: [],
      },
      answers: [
        {
          question_key: "question_1",
          text: "I like turning messy data into tools people use every day.",
          fact_ids: ["ans.why_field"],
        },
      ],
      cover_letter: null,
      fit_note: { why: "Python.", gaps: "" },
    }),
    truth_check: () => ({ verdicts: [] }),
  });
  const prepped = await prepareOne({ store, profile, llm, fetch, outDir }, posting, "B");
  expect(prepped.status).toBe("ready");
  store.setStatus(prepped.applicationId, "approved");

  const server = buildServer({
    store,
    profile,
    token: TOKEN,
    outDir,
    snapshotsDir: join(outDir, "snap"),
    uiDir: null,
    allowedHosts: [HOST],
  });
  const api = async (method: "POST", url: string, payload: object) =>
    (
      await server.inject({ method, url, payload, headers: { host: HOST, "x-ia-token": TOKEN } })
    ).json();

  const next = await api("POST", "/api/session/next", {});
  expect(next.done).toBe(false);

  await page.setContent(FIXTURE);
  await page.addScriptTag({ content: bundle });
  const results = await page.evaluate((app) => {
    const IA = (window as unknown as { IA: typeof Adapters }).IA;
    const files = { resume: IA.base64ToFile(app.files.resume.base64, app.files.resume.name) };
    const r = IA.fillForm(IA.greenhouse, document, app.fields, files);
    IA.highlightSubmit(IA.greenhouse, document);
    return r;
  }, next.application);

  expect(results.filter((r: { status: string }) => r.status === "not_found")).toEqual([]);
  await expect(page.locator("#first_name")).toHaveValue("Alex");
  await expect(page.locator("#email")).toHaveValue("alex@example.com");
  await expect(page.locator("#question_1")).toHaveValue(/messy data/);
  await expect(page.locator("#question_2 option:checked")).toHaveText("No");
  await expect(page.locator("#gender option:checked")).toHaveText("I don't wish to answer");
  expect(
    await page.locator("#resume").evaluate((el: HTMLInputElement) => el.files?.[0]?.name),
  ).toBe("Alex_Example_Resume.pdf");
  await expect(page.locator("#submit_app")).toHaveAttribute("data-ia-highlight", "submit");
  expect(
    await page.evaluate(() => (window as unknown as { __submitted: number }).__submitted),
  ).toBe(0);

  const seen = Object.fromEntries(
    results.map((r: { key: string; seen: string | null }) => [r.key, r.seen]),
  );
  const filled = await api("POST", `/api/applications/${next.application.id}/filled`, { seen });
  expect(filled.mismatches).toEqual([]);

  // The person, not the tool, presses Submit.
  await page.click("#submit_app");
  expect(
    await page.evaluate(() => (window as unknown as { __submitted: number }).__submitted),
  ).toBe(1);
  await page.addScriptTag({ content: bundle });
  const confirmed = await page.evaluate(() => {
    const IA = (window as unknown as { IA: typeof Adapters }).IA;
    return IA.greenhouse.isConfirmation(
      document,
      new URL("https://job-boards.greenhouse.io/exampleco/jobs/123/confirmation"),
    );
  });
  expect(confirmed).toBe(true);

  const done = await api("POST", `/api/applications/${next.application.id}/submitted`, {
    detectedBy: "confirmation_page",
  });
  expect(done.application.status).toBe("submitted");
  expect((await api("POST", "/api/session/next", {})).done).toBe(true);
  await server.close();
});
