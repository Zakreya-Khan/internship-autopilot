// End to end in real Chromium: the built review UI's Questions inbox. One answer fills the same
// question on two applications and both become Ready. Fictional data only; no model calls.
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { FillEntry } from "@ia/core";
import { makePosting, testProfile } from "@ia/core/testing";
import { buildServer } from "../apps/server/src/api.ts";
import { Store } from "../apps/server/src/db.ts";

const UI = join(process.cwd(), "apps/ui/dist");

const relocate = (label: string): FillEntry => ({
  key: "relocate",
  label,
  type: "select",
  required: true,
  options: ["Yes", "No"],
  value: null,
  source: "you",
  confidence: "low",
  flag: "red",
  note: "Needs you: not recognized.",
});

test("answering once in the inbox makes two applications ready", async ({ page }) => {
  test.skip(!existsSync(join(UI, "index.html")), "build the UI first (npm run build)");
  const store = new Store(":memory:");
  const ids = [
    ["Alpha Co", "Are you willing to relocate for this internship?"],
    ["Beta Co", "Would you be open to relocation?"],
  ].map(([company, label], i) => {
    const p = makePosting({ id: `p${i}`, company: company!, title: "Software Engineer Intern" });
    store.savePostings([p]);
    const a = store.createApplication(p.id, "A");
    store.replaceFieldFills(a.id, [relocate(label!)]);
    store.setStatus(a.id, "needs_input");
    return a.id;
  });

  const hosts: string[] = [];
  const app = buildServer({
    store,
    profile: testProfile(),
    token: "e2e-token",
    outDir: "/nonexistent",
    snapshotsDir: "/nonexistent",
    uiDir: UI,
    allowedHosts: hosts,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as AddressInfo;
  hosts.push(`127.0.0.1:${port}`);
  try {
    await page.goto(`http://127.0.0.1:${port}/#/questions`);
    // The nav badge counts one question (two wordings, grouped).
    await expect(page.getByRole("link", { name: /Questions/ })).toContainText("1");
    const card = page.getByRole("region", {
      name: "Are you willing to relocate for this internship?",
    });
    await expect(card).toContainText("Also asked as:");
    await expect(card).toContainText("Would you be open to relocation?");
    await expect(card).toContainText("Asked by 2 applications: Alpha Co, Beta Co");
    await card.getByLabel("Yes", { exact: true }).check();
    await expect(card.getByLabel("Always reuse")).toBeChecked();
    await card.getByRole("button", { name: "Answer for all 2" }).click();
    await expect(page.getByRole("status")).toContainText("Filled 2 fields");
    await expect(page.getByText("Nothing waiting for you.")).toBeVisible();
    expect(ids.map((id) => store.getApplication(id)!.status)).toEqual(["ready", "ready"]);

    // The answer bank shows it, used by both.
    await page.goto(`http://127.0.0.1:${port}/#/answers`);
    await expect(page.getByRole("cell", { name: /Are you willing to relocate/ })).toContainText(
      "Would you be open to relocation?",
    );
    await expect(page.getByRole("cell", { name: /2 applications/ })).toBeVisible();
  } finally {
    await app.close();
    store.close();
  }
});
