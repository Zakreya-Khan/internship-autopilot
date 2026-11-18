// The Claude CLI provider, against a fake `claude` binary on PATH. Nothing here runs the real CLI.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makePosting, testProfile } from "@ia/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { LlmClient, LlmRequest } from "../src/index.ts";
import {
  CliUnavailableError,
  ClaudeCliLlm,
  claudeCliStatus,
  cliArgs,
  draftApplication,
  draftOutreach,
  draftStories,
  FakeLlm,
  findClaudeCli,
  mapFieldsWithModel,
  matchRequirements,
  MODELS,
  modelTruthCheck,
  sensitiveValues,
  testConnection,
  UsageLimitError,
} from "../src/index.ts";

const FAKE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
const profile = testProfile();

interface Run {
  argv: string[];
  stdin: string;
  cwd: string;
  cwdEntries: string[];
  sawCredentials: string[];
}

let dir: string;
let logFile: string;
let bin: string;

function env(mode = "ok", answers?: Record<string, unknown>): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${dir}${delimiter}/usr/bin${delimiter}/bin`,
    IA_CLAUDE_LOCATIONS: "",
    FAKE_CLAUDE_LOG: logFile,
    FAKE_CLAUDE_MODE: mode,
    // Present in the parent, so the test proves the CLI never sees them.
    ANTHROPIC_API_KEY: "sk-ant-test-not-a-real-key-000000000000",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
  };
  if (answers) {
    const f = join(dir, "answers.json");
    writeFileSync(f, JSON.stringify(answers));
    e.FAKE_CLAUDE_ANSWERS = f;
  }
  return e;
}

const runs = (): Run[] =>
  existsSync(logFile)
    ? readFileSync(logFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Run)
    : [];

const flag = (r: Run, name: string) => r.argv[r.argv.indexOf(name) + 1];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  bin = join(dir, "claude");
  writeFileSync(bin, `#!${process.execPath}\n${readFileSync(FAKE, "utf8")}`);
  chmodSync(bin, 0o755);
  logFile = join(dir, "runs.jsonl");
});

const Ping = z.object({ ok: z.boolean() });
const req = (over: Partial<LlmRequest<{ ok: boolean }>> = {}): LlmRequest<{ ok: boolean }> => ({
  purpose: "test",
  model: MODELS.haiku,
  effort: "low",
  system: "SYSTEM TEXT",
  user: "USER TEXT",
  schema: Ping,
  ...over,
});

describe("ClaudeCliLlm", () => {
  it("runs claude -p with no tools, no session and no settings, in an empty temp folder", async () => {
    const usage: unknown[] = [];
    const llm = new ClaudeCliLlm(bin, (u) => usage.push(u), { env: env() });
    const r = await llm.generate(req());
    expect(r.data).toEqual({ ok: true });
    const [run] = runs();
    expect(run!.argv.slice(0, 3)).toEqual(["-p", "--output-format", "json"]);
    expect(flag(run!, "--tools")).toBe("");
    expect(flag(run!, "--setting-sources")).toBe("");
    expect(run!.argv).toContain("--no-session-persistence");
    expect(run!.argv).toContain("--strict-mcp-config");
    expect(flag(run!, "--model")).toBe(MODELS.haiku);
    expect(flag(run!, "--effort")).toBe("low");
    expect(flag(run!, "--system-prompt")).toBe("SYSTEM TEXT");
    expect(JSON.parse(flag(run!, "--json-schema")!)).toMatchObject({
      properties: { ok: { type: "boolean" } },
    });
    expect(run!.stdin).toBe("USER TEXT");
    // An empty folder outside the repo, removed afterwards: no CLAUDE.md or project file is read.
    expect(run!.cwdEntries).toEqual([]);
    expect(run!.cwd).not.toContain(process.cwd());
    expect(existsSync(run!.cwd)).toBe(false);
    // API credentials are removed, so the CLI signs in with the subscription.
    expect(run!.sawCredentials).toEqual([]);
    expect(usage[0]).toMatchObject({
      purpose: "test",
      model: MODELS.haiku,
      provider: "cli",
      reportedUsd: 0.0123,
      usage: { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 100 },
    });
  });

  it("reads a fenced JSON result when there's no structured output", async () => {
    const llm = new ClaudeCliLlm(bin, undefined, { env: env("fenced") });
    expect((await llm.generate(req())).data).toEqual({ ok: true });
  });

  it("retries once when the answer doesn't fit the schema, then gives up", async () => {
    const llm = new ClaudeCliLlm(bin, undefined, { env: env("bad-then-good") });
    expect((await llm.generate(req())).data).toEqual({ ok: true });
    expect(runs()).toHaveLength(2);
    const bad = new ClaudeCliLlm(bin, undefined, { env: env("always-bad") });
    await expect(bad.generate(req())).rejects.toThrow(/didn't match the expected format/);
    expect(runs()).toHaveLength(4);
  });

  it("stops at the subscription's usage limit and never retries", async () => {
    const llm = new ClaudeCliLlm(bin, undefined, { env: env("limit") });
    await expect(llm.generate(req())).rejects.toBeInstanceOf(UsageLimitError);
    await expect(llm.generate(req())).rejects.toBeInstanceOf(UsageLimitError);
    expect(runs()).toHaveLength(1); // the second call never ran the CLI
  });

  it("says when the CLI isn't signed in, or fails", async () => {
    const out = new ClaudeCliLlm(bin, undefined, { env: env("logged-out") });
    await expect(out.generate(req())).rejects.toBeInstanceOf(CliUnavailableError);
    await expect(out.generate(req())).rejects.toBeInstanceOf(CliUnavailableError);
    expect(runs()).toHaveLength(1); // signed out stays signed out for this run: not asked again
    await expect(
      new ClaudeCliLlm(bin, undefined, { env: env("crash") }).generate(req()),
    ).rejects.toThrow(/boom/);
    await expect(
      new ClaudeCliLlm(join(dir, "missing"), undefined, { env: env() }).generate(req()),
    ).rejects.toBeInstanceOf(CliUnavailableError);
  });

  it("works for the connection test", async () => {
    const r = await testConnection(new ClaudeCliLlm(bin, undefined, { env: env() }));
    expect(r).toMatchObject({ ok: true, model: MODELS.haiku });
  });
});

describe("finding the CLI and its status", () => {
  it("finds claude on PATH, or at an explicit path", () => {
    expect(findClaudeCli(null, env())).toBe(bin);
    expect(findClaudeCli(bin, env())).toBe(bin);
    expect(findClaudeCli(join(dir, "nope"), env())).toBeNull();
    expect(findClaudeCli(null, { PATH: "/usr/bin:/bin", IA_CLAUDE_LOCATIONS: "" })).toBeNull();
    expect(findClaudeCli(null, { PATH: "", IA_CLAUDE_LOCATIONS: bin })).toBe(bin);
  });

  it("reports version and sign-in, never the account's email or organization", async () => {
    const s = await claudeCliStatus(bin, env());
    expect(s).toEqual({
      found: true,
      path: bin,
      version: "2.1.999",
      signedIn: true,
      authMethod: "claude.ai",
      problem: null,
    });
    expect(JSON.stringify(s)).not.toMatch(/someone@example\.com|Example Org/);
    expect(await claudeCliStatus(bin, env("logged-out"))).toMatchObject({
      signedIn: false,
      problem: expect.stringMatching(/Not signed in/),
    });
    expect((await claudeCliStatus(join(dir, "nope"), env())).found).toBe(false);
  });
});

describe("both providers get the same redacted payload", () => {
  const answers = {
    required: { required: ["Python"], matched: ["Python"] },
    verdicts: { verdicts: [{ where: "a", supported: true, problem: "" }] },
    matches: { matches: [] },
    stories: { stories: [] },
    message: { message: "Hi there.", fact_ids: [] },
    resume: {
      resume: { entries: [], skills_order: [], courses: [] },
      answers: [],
      cover_letter: [],
      fit_note: { why: "x", gaps: "y" },
    },
  };
  const posting = makePosting({ descriptionText: "We need Python and SQL." });
  // Every model call the app makes, run through a given client.
  const everyCall = async (llm: LlmClient) => {
    await matchRequirements(llm, posting, profile);
    await draftApplication(llm, {
      profile,
      posting,
      tier: "A",
      openQuestions: [{ key: "why", label: "Why us?", required: true, type: "textarea" }],
      coverLetter: true,
      coverBase: { greeting: "Hello,", paragraphs: ["My own letter."], closing: "Thanks" },
    });
    await modelTruthCheck(llm, profile, [
      { where: "a", text: "Built it", factIds: ["exp.lab.f1"], mustCite: true },
    ]);
    await mapFieldsWithModel(
      llm,
      [{ key: "f1", label: "Portfolio", type: "text", required: false }] as never,
      [{ key: "website", label: "Website", value: "https://example.com", attach: null }] as never,
    );
    await draftStories(llm, profile, 3).catch(() => undefined);
    await draftOutreach(llm, profile, posting, "recruiter").catch(() => undefined);
  };

  it("sends the CLI exactly what the API path sends, with no sensitive values", async () => {
    const fake = new FakeLlm(
      Object.fromEntries(
        ["requirements", "draft", "truth_check", "map_fields", "stories", "outreach"].map((p) => [
          p,
          (r: LlmRequest<unknown>) => {
            const keys = Object.keys(
              (cliArgs(r).includes("--json-schema")
                ? JSON.parse(cliArgs(r)[cliArgs(r).indexOf("--json-schema") + 1]!)
                : {}
              ).properties ?? {},
            );
            return answers[keys.find((k) => k in answers) as keyof typeof answers];
          },
        ]),
      ),
    );
    await everyCall(fake);
    await everyCall(new ClaudeCliLlm(bin, undefined, { env: env("ok", answers) }));
    const cli = runs();
    expect(cli.length).toBe(fake.requests.length);
    expect(cli.length).toBeGreaterThanOrEqual(6);
    const secrets = sensitiveValues(profile);
    expect(secrets.length).toBeGreaterThan(0);
    fake.requests.forEach((r, i) => {
      const run = cli[i]!;
      expect(flag(run, "--system-prompt")).toBe(r.system);
      expect(run.stdin).toBe(r.user);
      expect(flag(run, "--model")).toBe(r.model);
      for (const v of secrets) {
        expect(`${r.system}\n${r.user}`).not.toContain(v);
        expect(run.argv.join("\n") + run.stdin).not.toContain(v);
      }
    });
  });
});
