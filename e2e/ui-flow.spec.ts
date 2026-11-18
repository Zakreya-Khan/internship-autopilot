// The review UI on its own, in real Chromium with the real built extension: find a posting in
// Discover → tick it → Prepare (a background job) → approve it in the queue → Open & fill opens
// the application in a new tab and the extension fills it. The test stops there: nothing is
// submitted. Fictional data; the job board is served from fixtures/forms by a Playwright route.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "@playwright/test";
import { chromium, expect, test } from "@playwright/test";
import type { FormQuestion } from "@ia/core";
import { makePosting, testProfile } from "@ia/core/testing";
import { buildServer } from "../apps/server/src/api.ts";
import { Store } from "../apps/server/src/db.ts";
import { JobRunner } from "../apps/server/src/jobs.ts";

const ROOT = process.cwd();
const UI = join(ROOT, "apps/ui/dist");
const TOKEN = "e2e-ui-token";
const APPLY = "https://job-boards.greenhouse.io/exampleco/jobs/9001";
const QUESTIONS: FormQuestion[] = [
  { key: "first_name", label: "First Name", required: true, type: "text" },
  { key: "last_name", label: "Last Name", required: true, type: "text" },
  { key: "email", label: "Email", required: true, type: "text" },
  { key: "resume", label: "Resume/CV", required: true, type: "file" },
];

const temp: string[] = [];
let context: BrowserContext | undefined;
test.afterAll(async () => {
  await context?.close();
  for (const d of temp) rmSync(d, { recursive: true, force: true });
});

test("find → prepare → approve → Open & fill, all from the review UI", async () => {
  test.skip(!existsSync(join(UI, "index.html")), "build the UI first (npm run build)");
  test.setTimeout(120_000);
  execFileSync("npx", ["tsx", "apps/extension/scripts/build.ts"], { cwd: ROOT, stdio: "pipe" });
  const extensionDir = mkdtempSync(join(tmpdir(), "ia-ext-"));
  const outDir = mkdtempSync(join(tmpdir(), "ia-ui-out-"));
  const userData = mkdtempSync(join(tmpdir(), "ia-chrome-"));
  temp.push(extensionDir, outDir, userData);
  cpSync(join(ROOT, "apps/extension/dist"), extensionDir, { recursive: true });

  const profile = testProfile();
  const store = new Store(":memory:");
  const posting = makePosting({
    id: "greenhouse:exampleco:9001",
    company: "Example Co",
    title: "Software Engineer Intern",
    ats: "greenhouse",
    applyUrl: APPLY,
    questions: QUESTIONS,
  });
  store.savePostings([posting]);
  store.saveScore(
    posting.id,
    true,
    [],
    {
      score: 86,
      tier: "A",
      components: { skills: 0, roleFamily: 0, education: 0, location: 0, company: 0, freshness: 0 },
      match: { required: [], matched: [], missing: [], method: "keywords" },
    },
    "h",
  );
  const jobs = new JobRunner({
    store,
    profile: () => profile,
    llm: () => null, // no model: base resume, profile fields only
    provider: () => "api",
    llmReason: () => "offline test",
    fetch,
    outDir,
    home: outDir,
    liveness: () => async () => ({ verdict: "active", code: "ok", reason: "listed", via: "api" }),
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
    await context.route(`${APPLY}**`, (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ status: 200, contentType: "text/html", body: form })
        : route.abort(),
    );
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    await worker.evaluate(
      async ({ baseUrl, token }) => chrome.storage.local.set({ baseUrl, token }),
      { baseUrl: base, token: TOKEN },
    );

    const page = await context.newPage();
    // Home points at the work: nothing prepared yet, one Tier A posting to prepare.
    await page.goto(`${base}/#/`);
    await expect(page.getByRole("heading", { name: "What to do next" })).toBeVisible();
    await expect(page.getByText("1 Tier A or B posting not started")).toBeVisible();

    // Discover: filter, tick, prepare.
    await page.getByRole("navigation").getByRole("link", { name: "Discover" }).click();
    await page.getByLabel("Search").fill("software");
    const row = page.getByRole("row", { name: /Example Co/ });
    await expect(row).toBeVisible();
    await row.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Prepare 1" }).click();
    await expect(page.getByText(/^Prepared 1: 1 ready/)).toBeVisible({ timeout: 30_000 });
    await expect(row.getByRole("link", { name: "Ready to approve" })).toBeVisible();

    // Queue: approve with the keyboard.
    await page.goto(`${base}/#/queue/ready`);
    await expect(page.getByRole("cell", { name: "Example Co" })).toBeVisible();
    await page.keyboard.press("a");
    await expect(page.getByText("Example Co: approved.")).toBeVisible();

    // Open & fill: a new tab at the application page; the extension fills it.
    await page.goto(`${base}/#/queue/approved`);
    const [tab] = await Promise.all([
      context.waitForEvent("page"),
      page.getByRole("button", { name: "Open & fill" }).click(),
    ]);
    await expect(page.getByText(/Opened Example Co in a new tab/)).toBeVisible();
    await tab.waitForURL(`${APPLY}**`);
    const id = store.applicationForPosting(posting.id)!.id;
    await expect.poll(() => store.getApplication(id)!.status, { timeout: 30_000 }).toBe("filled");
    await expect(tab.locator("#first_name")).toHaveValue("Alex");
    await expect(tab.locator("#email")).toHaveValue("alex@example.com");
    // Stopped before Submit: the person presses it, never the tool.
    expect(store.getApplication(id)!.status).toBe("filled");
  } finally {
    await server.close();
    store.close();
  }
});
