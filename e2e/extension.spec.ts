// The whole loop through the real, built extension in Chromium: approve → Start session in the
// side panel → the extension opens and fills each application → the person presses Submit
// (simulated here, by the test, never by the extension) → the tracker updates. One application
// per platform: Greenhouse, Lever, Ashby, Workday, SmartRecruiters, iCIMS and the generic filler.
// Plus one approved posting that closed after approval, which the session must skip.
// Fixtures are fictional; job-board hosts are served from fixtures/forms by Playwright routes.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { chromium, expect, test } from "@playwright/test";
import type { FormQuestion, Posting } from "@ia/core";
import { makePosting, testProfile } from "@ia/core/testing";
import type { LivenessCheck } from "../apps/server/src/liveness.ts";
import { buildServer } from "../apps/server/src/api.ts";
import { Store } from "../apps/server/src/db.ts";
import { prepareOne } from "../apps/server/src/prep.ts";

const ROOT = process.cwd();
const TOKEN = "e2e-extension-token";
const fixture = (name: string) => readFileSync(join(ROOT, "fixtures/forms", name), "utf8");

const GH_QUESTIONS: FormQuestion[] = [
  { key: "first_name", label: "First Name", required: true, type: "text" },
  { key: "last_name", label: "Last Name", required: true, type: "text" },
  { key: "email", label: "Email", required: true, type: "text" },
  { key: "phone", label: "Phone", required: false, type: "text" },
  { key: "resume", label: "Resume/CV", required: true, type: "file" },
  {
    key: "question_2",
    label: "Will you require visa sponsorship?",
    required: true,
    type: "select",
    options: ["Yes", "No"],
  },
];

interface Case {
  name: string;
  posting: Partial<Posting>;
  /** URL prefix served from a fixture. */
  route: string;
  fixture: string;
  /** Field selector → value the extension must have filled. */
  expectFilled: Record<string, string>;
  /** How the person submits: press the site's button, or say "It went through" in the panel. */
  submit: { click: string; confirmPage?: boolean } | "panel";
}

const CASES: Case[] = [
  {
    name: "greenhouse",
    posting: {
      id: "greenhouse:exampleco:9001",
      ats: "greenhouse",
      applyUrl: "https://job-boards.greenhouse.io/exampleco/jobs/9001",
      questions: GH_QUESTIONS,
    },
    route: "https://job-boards.greenhouse.io/exampleco/jobs/9001",
    fixture: "greenhouse.html",
    expectFilled: { "#first_name": "Alex", "#email": "alex@example.com" },
    submit: { click: "#submit_app" },
  },
  {
    name: "lever",
    posting: {
      id: "lever:acme:5b0c2f1e-1111-4222-8333-944455556666",
      ats: "lever",
      boardToken: "acme",
      atsJobId: "5b0c2f1e-1111-4222-8333-944455556666",
      applyUrl: "https://jobs.lever.co/acme/5b0c2f1e-1111-4222-8333-944455556666/apply",
    },
    route: "https://jobs.lever.co/acme/",
    fixture: "lever.html",
    expectFilled: { "#name": "Alex Example", "#email-in": "alex@example.com" },
    submit: { click: "#btn-submit", confirmPage: true },
  },
  {
    name: "ashby",
    posting: {
      id: "ashby:acme:0a1b2c3d-0000-4000-8000-000000000001",
      ats: "ashby",
      boardToken: "acme",
      atsJobId: "0a1b2c3d-0000-4000-8000-000000000001",
      applyUrl: "https://jobs.ashbyhq.com/acme/0a1b2c3d-0000-4000-8000-000000000001/application",
    },
    route: "https://jobs.ashbyhq.com/acme/",
    fixture: "ashby.html",
    expectFilled: { "#_systemfield_name": "Alex Example" },
    submit: { click: ".ashby-application-form-submit-button", confirmPage: true },
  },
  {
    name: "workday",
    posting: {
      id: "workday:exampleco:JR4242",
      ats: "workday",
      boardToken: "exampleco",
      atsJobId: "JR4242",
      applyUrl: "https://exampleco.wd5.myworkdayjobs.com/Careers/job/Remote/Intern_JR4242/apply",
    },
    route: "https://exampleco.wd5.myworkdayjobs.com/",
    fixture: "workday.html",
    expectFilled: {},
    submit: { click: "[data-automation-id=pageFooterSubmitButton]", confirmPage: true },
  },
  {
    name: "smartrecruiters",
    posting: {
      id: "smartrecruiters:exampleco:744000000001",
      ats: "smartrecruiters",
      boardToken: "ExampleCo",
      atsJobId: "744000000001",
      applyUrl: "https://jobs.smartrecruiters.com/ExampleCo/744000000001",
    },
    route: "https://jobs.smartrecruiters.com/ExampleCo/",
    fixture: "smartrecruiters.html",
    expectFilled: { "#first-name-input": "Alex", "#email-input": "alex@example.com" },
    submit: "panel",
  },
  {
    name: "icims",
    posting: {
      id: "icims:exampleco:1234",
      ats: "icims",
      boardToken: "exampleco",
      atsJobId: "1234",
      applyUrl: "https://careers-exampleco.icims.com/jobs/1234/software-intern/candidate",
    },
    route: "https://careers-exampleco.icims.com/",
    fixture: "icims.html",
    expectFilled: { "[id='PersonProfileFields.FirstName']": "Alex" },
    submit: { click: "#submit_btn" },
  },
  {
    name: "generic",
    posting: {
      id: "url:https://careers.example.com/apply/55",
      ats: "other",
      boardToken: null,
      atsJobId: null,
      applyUrl: "https://careers.example.com/apply/55",
    },
    route: "https://careers.example.com/",
    fixture: "generic.html",
    expectFilled: { "#a2": "alex@example.com" },
    submit: { click: "button[type=submit]", confirmPage: true },
  },
];

const CLOSED: Partial<Posting> = {
  id: "greenhouse:exampleco:9999",
  company: "Closed Co",
  ats: "greenhouse",
  applyUrl: "https://job-boards.greenhouse.io/exampleco/jobs/9999",
  questions: GH_QUESTIONS,
};

let context: BrowserContext;
let extensionDir: string;
const temp: string[] = [];

test.beforeAll(() => {
  // Build the real extension, then load a copy whose manifest also pre-grants the generic test
  // host. In real use Chrome asks you to allow an unknown site; a test can't answer that prompt.
  execFileSync("npx", ["tsx", "apps/extension/scripts/build.ts"], { cwd: ROOT, stdio: "pipe" });
  extensionDir = mkdtempSync(join(tmpdir(), "ia-ext-"));
  temp.push(extensionDir);
  cpSync(join(ROOT, "apps/extension/dist"), extensionDir, { recursive: true });
  const manifestPath = join(extensionDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    host_permissions: string[];
  };
  manifest.host_permissions.push("https://careers.example.com/*");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
});

test.afterAll(async () => {
  await context?.close();
  for (const d of temp) rmSync(d, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

async function waitForStatus(
  api: (url: string) => Promise<{ application: { status: string } }>,
  id: number,
  want: string,
): Promise<void> {
  await expect
    .poll(async () => (await api(`/api/applications/${id}`)).application.status, {
      timeout: 30_000,
    })
    .toBe(want);
}

test("the built extension runs the whole session across every platform", async () => {
  test.setTimeout(240_000);
  const profile = testProfile();
  const store = new Store(":memory:");
  const outDir = mkdtempSync(join(tmpdir(), "ia-e2e-out-"));
  temp.push(outDir);

  // Prepare and approve one application per platform, plus one whose posting will be closed.
  const ids: Record<string, number> = {};
  const all = [...CASES.map((c, i) => ({ c, i })), { c: null, i: -1 }];
  for (const { c, i } of all) {
    const posting = makePosting({
      company: c ? `${c.name} Co` : "Closed Co",
      // Earlier deadline first: the session runs them in this order, the closed one first.
      deadline: c ? `2026-12-${String(10 + i).padStart(2, "0")}` : "2026-12-01",
      ...(c ? c.posting : CLOSED),
    });
    store.savePostings([posting]);
    const r = await prepareOne({ store, profile, llm: null, fetch, outDir }, posting, "A");
    expect(r.status, `${c?.name ?? "closed"} prepared`).toBe("ready");
    store.setStatus(r.applicationId, "approved");
    ids[c?.name ?? "closed"] = r.applicationId;
  }

  const liveness: LivenessCheck = async (p) =>
    p.id === CLOSED.id
      ? { verdict: "expired", code: "greenhouse_api_gone", reason: "HTTP 404", via: "api" }
      : { verdict: "active", code: "ok", reason: "listed", via: "api" };
  const port = await freePort();
  const server = buildServer({
    store,
    profile,
    token: TOKEN,
    outDir,
    snapshotsDir: join(outDir, "snapshots"),
    uiDir: null,
    allowedHosts: [`127.0.0.1:${port}`],
    liveness,
  });
  await server.listen({ host: "127.0.0.1", port });
  const base = `http://127.0.0.1:${port}`;
  const api = async (url: string) =>
    (await fetch(`${base}${url}`, { headers: { "x-ia-token": TOKEN } })).json();

  const userData = mkdtempSync(join(tmpdir(), "ia-chrome-"));
  temp.push(userData);
  context = await chromium.launchPersistentContext(userData, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      // No real job board is ever contacted: every name fails to resolve, and the fixture
      // hosts are answered by the routes below.
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    ],
  });
  for (const c of CASES)
    await context.route(`${c.route}**`, (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ status: 200, contentType: "text/html", body: fixture(c.fixture) })
        : route.abort(),
    );

  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(
    async ({ baseUrl, token }) => chrome.storage.local.set({ baseUrl, token }),
    { baseUrl: base, token: TOKEN },
  );

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.click("#start");

  const pageFor = async (prefix: string): Promise<Page> => {
    const host = new URL(prefix).host;
    try {
      await expect
        .poll(
          async () => {
            const tab = context.pages().find((p) => p.url().includes(host));
            if (!tab) return false;
            // A tab the extension creates starts loading before Playwright can route it; when
            // that first load missed the fixture, load the same URL again through the route.
            if (!tab.url().startsWith(prefix) || (await tab.title().catch(() => "")) === "") {
              await tab.goto(prefix).catch(() => {});
            }
            return tab.url().startsWith(prefix);
          },
          { timeout: 20_000 },
        )
        .toBe(true);
    } catch (e) {
      const tabs = context.pages().map((p) => p.url());
      throw new Error(
        `no tab at ${prefix}; tabs: ${tabs.join(", ")}; panel: ${await panel.locator("body").innerText()}`,
        { cause: e },
      );
    }
    return context.pages().find((p) => p.url().startsWith(prefix))!;
  };

  for (const c of CASES) {
    const id = ids[c.name]!;
    const tab = await pageFor(c.posting.applyUrl!);
    if (c.name === "generic") {
      // An unknown site: the session waits for you to allow it ("Fill this page").
      await expect(panel.locator("#generic")).toBeVisible();
      await panel.evaluate(() => chrome.runtime.sendMessage({ type: "session:inject" }));
    }
    await waitForStatus(api, id, "filled");
    for (const [sel, value] of Object.entries(c.expectFilled))
      await expect(tab.locator(sel), `${c.name} ${sel}`).toHaveValue(value);
    if (c.name === "workday") {
      // The wizard stopped on Review with Submit outlined and untouched.
      await expect(tab.locator("[data-automation-id=reviewJobApplicationPage]")).toBeVisible();
      expect(
        await tab.evaluate(() => (window as unknown as { __submitClicks: number }).__submitClicks),
      ).toBe(0);
      expect(
        await tab.evaluate(
          () => (window as unknown as { __values: Record<string, string> }).__values,
        ),
      ).toMatchObject({
        fn: "Alex",
        em: "alex@example.com",
      });
    }
    if (c.name === "generic")
      await expect(tab.locator("#a3"), "password field never filled").toHaveValue("");
    if (["greenhouse", "icims"].includes(c.name))
      expect(
        await tab.evaluate(() => (window as unknown as { __submitted: number }).__submitted),
      ).toBe(0);

    // The person presses Submit. The site then shows its confirmation page.
    if (c.submit === "panel") {
      await panel.click("#confirm");
    } else {
      if (c.submit.confirmPage)
        // Play the site's part: when the person's Submit goes through, show a confirmation.
        await tab.evaluate(() => {
          const confirm = () => {
            document.body.innerHTML =
              "<h1>Thank you for applying!</h1><p>Your application has been submitted.</p>";
          };
          document.addEventListener(
            "submit",
            (e) => {
              e.preventDefault();
              confirm();
            },
            true,
          );
          document.addEventListener("click", (e) => {
            const t = e.target as HTMLElement;
            if (t.closest("[data-automation-id=pageFooterSubmitButton]")) setTimeout(confirm, 0);
          });
        });
      await tab
        .locator(c.submit.click)
        .evaluate((el: HTMLElement) =>
          el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })),
        );
    }
    await waitForStatus(api, id, "submitted");
  }

  // The posting that closed after approval was skipped, recorded, and reported in the panel.
  expect(store.getApplication(ids.closed!)!.status).toBe("skipped");
  expect(store.getLiveness(CLOSED.id!)).toMatchObject({ verdict: "expired" });
  await expect(panel.locator("#issues")).toContainText("Closed since approval, skipped");
  await expect(panel.locator("#phase")).toHaveText("All approved applications are done.");
  const tracker = (await api("/api/tracker")) as { status: string }[];
  expect(tracker.filter((t) => t.status === "submitted")).toHaveLength(CASES.length);
  await server.close();
});
