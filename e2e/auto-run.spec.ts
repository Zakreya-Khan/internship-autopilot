// Auto-run, in real Chromium with the real built extension: with the review UI open, approving an
// application is the last thing the person does before Submit. The extension opens it by itself,
// goes from the job description to the form through its "Apply" link, and fills it. The test
// presses nothing in that tab and stops before Submit. Fictional data; the job board is served
// from fixtures by Playwright routes.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { chromium, expect, test } from "@playwright/test";
import type { FormQuestion } from "@ia/core";
import { makePosting, testProfile } from "@ia/core/testing";
import { buildServer } from "../apps/server/src/api.ts";
import { Store } from "../apps/server/src/db.ts";
import { JobRunner } from "../apps/server/src/jobs.ts";
import { prepareOne } from "../apps/server/src/prep.ts";

const ROOT = process.cwd();
const UI = join(ROOT, "apps/ui/dist");
const TOKEN = "e2e-auto-token";
const POSTING = "https://job-boards.greenhouse.io/exampleco/jobs/9002";
const FORM = `${POSTING}/apply`;
const QUESTIONS: FormQuestion[] = [
  { key: "first_name", label: "First Name", required: true, type: "text" },
  { key: "last_name", label: "Last Name", required: true, type: "text" },
  { key: "email", label: "Email", required: true, type: "text" },
  { key: "resume", label: "Resume/CV", required: true, type: "file" },
];
const DESCRIPTION = `<!doctype html><html><head><title>Software Engineer Intern</title></head>
<body><h1>Software Engineer Intern</h1><p>Fictional job description.</p>
<a href="/exampleco/jobs/9002/apply">Apply for this job</a></body></html>`;

const temp: string[] = [];
let context: BrowserContext | undefined;
test.afterAll(async () => {
  await context?.close();
  for (const d of temp) rmSync(d, { recursive: true, force: true });
});

test("approve in the review UI → it opens, goes to the form and fills, with no other input", async () => {
  test.skip(!existsSync(join(UI, "index.html")), "build the UI first (npm run build)");
  test.setTimeout(120_000);
  const extensionDir = mkdtempSync(join(tmpdir(), "ia-ext-"));
  const outDir = mkdtempSync(join(tmpdir(), "ia-auto-out-"));
  const userData = mkdtempSync(join(tmpdir(), "ia-chrome-"));
  temp.push(extensionDir, outDir, userData);
  execFileSync("npx", ["tsx", "apps/extension/scripts/build.ts"], {
    cwd: ROOT,
    stdio: "pipe",
    env: { ...process.env, IA_EXT_OUT: extensionDir },
  });

  const profile = testProfile();
  const store = new Store(":memory:");
  const posting = makePosting({
    id: "greenhouse:exampleco:9002",
    company: "Example Co",
    title: "Software Engineer Intern",
    ats: "greenhouse",
    applyUrl: POSTING,
    questions: QUESTIONS,
  });
  store.savePostings([posting]);
  const prepared = await prepareOne({ store, profile, llm: null, fetch, outDir }, posting, "A");
  expect(prepared.status).toBe("ready");
  const id = prepared.applicationId;

  const jobs = new JobRunner({
    store,
    profile: () => profile,
    llm: () => null,
    provider: () => "api",
    llmReason: () => "offline test",
    fetch,
    outDir,
    home: outDir,
    liveness: () => null,
  });
  const hosts: string[] = [];
  const server = buildServer({
    store,
    profile,
    token: TOKEN,
    outDir,
    snapshotsDir: join(outDir, "snapshots"),
    uiDir: UI,
    allowedHosts: hosts,
    jobs,
    home: outDir,
  });
  await server.listen({ host: "127.0.0.1", port: 0 });
  const { port } = server.server.address() as AddressInfo;
  hosts.push(`127.0.0.1:${port}`);
  const base = `http://127.0.0.1:${port}`;

  try {
    context = await chromium.launchPersistentContext(userData, {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      ],
    });
    const form = readFileSync(join(ROOT, "fixtures/forms/greenhouse.html"), "utf8");
    await context.route(`${POSTING}**`, (route) => {
      if (route.request().method() !== "GET") return route.abort();
      const url = route.request().url();
      return route.fulfill({
        status: 200,
        contentType: "text/html",
        body: url.startsWith(FORM) ? form : DESCRIPTION,
      });
    });
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    await worker.evaluate(
      async ({ baseUrl, token }) => chrome.storage.local.set({ baseUrl, token }),
      { baseUrl: base, token: TOKEN },
    );

    const ui = await context.newPage();
    await ui.goto(`${base}/#/queue/ready`);
    // The page sees the extension, and auto-fill is on by default.
    await expect(ui.getByText("Auto-fill on")).toBeVisible({ timeout: 15_000 });
    await expect(ui.getByRole("cell", { name: "Example Co" })).toBeVisible();
    await ui.keyboard.press("a"); // the only thing the person does before Submit

    // The extension opens the posting by itself, follows "Apply for this job", fills the form.
    let tab: Page | undefined;
    await expect
      .poll(
        async () => {
          tab = context!.pages().find((p) => p.url().startsWith(POSTING));
          // An extension-made tab can start loading before Playwright routes it; load it again.
          if (tab && (await tab.title().catch(() => "")) === "")
            await tab.goto(POSTING).catch(() => {});
          return Boolean(tab);
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    await expect.poll(() => store.getApplication(id)!.status, { timeout: 30_000 }).toBe("filled");
    expect(tab!.url()).toBe(FORM);
    await expect(tab!.locator("#first_name")).toHaveValue("Alex");
    await expect(tab!.locator("#email")).toHaveValue("alex@example.com");
    // The review UI shows it's waiting for you.
    await expect(ui.getByText("Your Submit: Example Co")).toBeVisible({ timeout: 10_000 });
    expect(store.getApplication(id)!.status).toBe("filled"); // never submitted by the tool
  } finally {
    await server.close();
    store.close();
  }
});
