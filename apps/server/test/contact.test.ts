// Contact details come from the current profile, not the copy made at prep. Fictional data only.
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DraftOutput } from "@ia/ai";
import { FakeLlm } from "@ia/ai";
import type { FormQuestion, Profile } from "@ia/core";
import { makePosting, TEST_PROFILE_YAML, testProfile } from "@ia/core/testing";
import { extractPdfText } from "@ia/render";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/api.ts";
import { describeSync, syncContactDetails } from "../src/contact.ts";
import type { PrepDeps } from "../src/prep.ts";
import { prepareOne, resumePathFor } from "../src/prep.ts";
import { memoryStore, routeFetch } from "./helpers.ts";

const OLD = "alex@example.com";
const NEW = "alex.new@example.org";
const withEmail = (email: string): Profile =>
  testProfile((p) => ({ ...p, identity: { ...p.identity, email } }));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

const QUESTIONS: FormQuestion[] = [
  { key: "first_name", label: "First Name", required: true, type: "text" },
  { key: "email", label: "Email", required: true, type: "text" },
  { key: "phone", label: "Phone", required: true, type: "text" },
  { key: "resume", label: "Resume/CV", required: true, type: "file" },
  {
    key: "question_3",
    label: "Do you know anyone who works here?",
    required: true,
    type: "select",
    options: ["Yes", "No"],
  },
];

const draft = (): DraftOutput => ({
  resume: { entries: [], skills_order: ["python"], courses: [] },
  answers: [],
  cover_letter: null,
  fit_note: { why: "Python.", gaps: "None noted." },
});

/** One application prepared with the old email, answered and approved. */
async function approvedWithOldEmail(id = "p1") {
  const out = tempDir("ia-out-");
  const d: PrepDeps & { store: ReturnType<typeof memoryStore> } = {
    store: memoryStore(),
    profile: withEmail(OLD),
    fetch: routeFetch({}),
    llm: new FakeLlm({ draft, truth_check: () => ({ verdicts: [] }) }),
    outDir: out,
    now: () => new Date("2026-11-17T12:00:00Z"),
  };
  const posting = makePosting({ id, questions: QUESTIONS });
  d.store.savePostings([posting]);
  const { applicationId } = await prepareOne(d, posting, "A");
  d.store.setFieldByUser(applicationId, "question_3", "No");
  d.store.setStatus(applicationId, "ready");
  d.store.setStatus(applicationId, "approved");
  return { d, id: applicationId };
}

const field = (d: { store: ReturnType<typeof memoryStore> }, id: number, key: string) =>
  d.store.listFieldFills(id).find((f) => f.field_key === key)!;
const resumeText = async (outDir: string, id: number) =>
  extractPdfText(readFileSync(resumePathFor(outDir, id, "resume")));

describe("contact details from the current profile", () => {
  it("an approved application fills the new email after the profile changes", async () => {
    const { d, id } = await approvedWithOldEmail();
    expect(field(d, id, "email").planned_value).toBe(OLD);
    expect(await resumeText(d.outDir, id)).toContain(OLD);

    const HOST = "127.0.0.1:4317";
    const app = buildServer({
      store: d.store,
      profile: withEmail(NEW),
      token: "t",
      outDir: d.outDir,
      snapshotsDir: tempDir("ia-snap-"),
      uiDir: null,
      allowedHosts: [HOST],
    });
    const next = (
      await app.inject({
        method: "POST",
        url: "/api/session/next",
        payload: {},
        headers: { host: HOST, "x-ia-token": "t" },
      })
    ).json();
    const fields = Object.fromEntries(
      (next.application.fields as { key: string; value: string | null }[]).map((f) => [
        f.key,
        f.value,
      ]),
    );
    expect(fields.email).toBe(NEW);
    expect(fields.question_3).toBe("No"); // what you typed is untouched
    const attached = Buffer.from(next.application.files.resume.base64, "base64");
    expect(await extractPdfText(attached)).toContain(NEW);
    expect(await extractPdfText(attached)).not.toContain(OLD);
    // Still approved: only values from your profile changed, to what your profile now says.
    expect(d.store.getApplication(id)!.status).toBe("approved");
    const event = d.store.events(id).find((e) => e.type === "contact_refreshed")!;
    expect(JSON.stringify(event)).not.toContain(NEW);
    await app.close();
  });

  it("re-reads profile.yaml when it changes, without a restart", async () => {
    const { d, id } = await approvedWithOldEmail();
    const dir = tempDir("ia-profile-");
    const path = join(dir, "profile.yaml");
    writeFileSync(path, TEST_PROFILE_YAML);
    const HOST = "127.0.0.1:4317";
    const app = buildServer({
      store: d.store,
      profile: withEmail(OLD),
      token: "t",
      outDir: d.outDir,
      snapshotsDir: tempDir("ia-snap-"),
      uiDir: null,
      allowedHosts: [HOST],
      profilePath: path,
    });
    const get = () =>
      app.inject({ url: `/api/applications/${id}`, headers: { host: HOST, "x-ia-token": "t" } });
    const email = async () =>
      ((await get()).json().fields as { field_key: string; planned_value: string }[]).find(
        (f) => f.field_key === "email",
      )!.planned_value;
    expect(await email()).toBe(OLD);

    writeFileSync(path, TEST_PROFILE_YAML.replace(OLD, NEW));
    const later = statSync(path).mtimeMs / 1000 + 5;
    utimesSync(path, later, later);
    expect(await email()).toBe(NEW);
    expect(await resumeText(d.outDir, id)).toContain(NEW);

    // An edit that doesn't parse keeps the last good profile.
    writeFileSync(path, "identity: [unclosed");
    utimesSync(path, later + 5, later + 5);
    expect(await email()).toBe(NEW);
    await app.close();
  });

  it("leaves submitted applications and values you typed alone", async () => {
    const { d, id } = await approvedWithOldEmail();
    const { d: d2, id: typed } = await approvedWithOldEmail("p2");
    d2.store.setFieldByUser(typed, "email", "own@example.net");
    d.store.setStatus(id, "filled");
    d.store.setStatus(id, "submitted");
    const s1 = await syncContactDetails(d.store, withEmail(NEW), d.outDir);
    expect(s1.applications).toEqual([]);
    expect(field(d, id, "email").planned_value).toBe(OLD);
    expect(await resumeText(d.outDir, id)).toContain(OLD);
    await syncContactDetails(d2.store, withEmail(NEW), d2.outDir);
    expect(field(d2, typed, "email").planned_value).toBe("own@example.net");
  });

  it("sends an approved application back for review when a required contact value is gone", async () => {
    const { d, id } = await approvedWithOldEmail();
    const noPhone = testProfile((p) => ({ ...p, identity: { ...p.identity, phone: "" } }));
    const s = await syncContactDetails(d.store, noPhone, d.outDir);
    expect(s.sentBack).toEqual([id]);
    expect(field(d, id, "phone")).toMatchObject({ flag: "red" });
    expect(d.store.getApplication(id)!.status).toBe("needs_input");
    expect(describeSync(s)).toMatch(/1 approved application is back in review/);
    // Run again: nothing left to change.
    expect((await syncContactDetails(d.store, noPhone, d.outDir)).applications).toEqual([]);
  });
});
