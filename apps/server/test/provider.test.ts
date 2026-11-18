// Choosing between the Anthropic API key and the Claude CLI (subscription).
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AnthropicLlm, ClaudeCliLlm, FakeLlm, UsageLimitError } from "@ia/ai";
import { makePosting, testProfile } from "@ia/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/api.ts";
import { takeProvider } from "../src/cli.ts";
import type { Paths } from "../src/config.ts";
import { runScoring } from "../src/pipeline.ts";
import { runPrep } from "../src/prep.ts";
import {
  apiKeySource,
  buildLlm,
  keyHint,
  readProviderSettings,
  saveKey,
  saveProviderSettings,
  savedKeyPath,
} from "../src/provider.ts";
import { memoryStore, routeFetch } from "./helpers.ts";

const FAKE = fileURLToPath(new URL("../../../packages/ai/test/fake-claude.mjs", import.meta.url));
const KEY = "sk-ant-api03-fictional-test-key-ABCDEFGHIJKLMNOP-wxyz";
const HOST = "127.0.0.1:4317";
const TOKEN = "t".repeat(32);
const profile = testProfile();

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), "ia-home-"));
  dirs.push(home);
  const paths: Paths = {
    home,
    db: ":memory:",
    out: join(home, "out"),
    snapshots: join(home, "snapshots"),
    profile: join(home, "profile.yaml"),
  };
  const bin = join(home, "claude");
  writeFileSync(bin, `#!/usr/bin/env node\n${readFileSync(FAKE, "utf8")}`);
  chmodSync(bin, 0o755);
  // A PATH without any real claude, and no API credentials.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", HOME: home };
  return { store: memoryStore(), paths, bin, env };
}

describe("provider settings", () => {
  it("defaults to the API, saves the choice in the local database, and rejects unknown ones", () => {
    const { store } = setup();
    expect(readProviderSettings(store)).toEqual({ provider: "api", cliPath: null });
    saveProviderSettings(store, { provider: "cli", cliPath: "/opt/claude" });
    expect(readProviderSettings(store)).toEqual({ provider: "cli", cliPath: "/opt/claude" });
    expect(() => saveProviderSettings(store, { provider: "gpt" as never })).toThrow();
  });

  it("builds the client for the chosen provider; --provider overrides the saved choice", () => {
    const { store, paths, bin, env } = setup();
    expect(buildLlm({ store, paths, env })).toMatchObject({
      provider: "api",
      llm: null,
      reason: expect.stringMatching(/No Anthropic API key/),
    });
    expect(buildLlm({ store, paths, env: { ...env, ANTHROPIC_API_KEY: KEY } }).llm).toBeInstanceOf(
      AnthropicLlm,
    );
    saveProviderSettings(store, { provider: "cli", cliPath: join(paths.home, "missing") });
    expect(buildLlm({ store, paths, env })).toMatchObject({ provider: "cli", llm: null });
    saveProviderSettings(store, { cliPath: bin });
    const cli = buildLlm({ store, paths, env });
    expect(cli.llm).toBeInstanceOf(ClaudeCliLlm);
    expect(buildLlm({ store, paths, env, override: "api" }).provider).toBe("api");
  });

  it("saves a pasted key 0600 under data/, prefers the environment's, and shows 4 characters at most", () => {
    const { paths, env } = setup();
    expect(() => saveKey(paths, "hello")).toThrow(/doesn't look like/);
    saveKey(paths, `  ${KEY}\n`);
    expect(statSync(savedKeyPath(paths)).mode & 0o777).toBe(0o600);
    expect(apiKeySource(paths, env)).toEqual({ source: "saved", key: KEY });
    expect(apiKeySource(paths, { ...env, ANTHROPIC_API_KEY: "sk-ant-env" }).source).toBe(
      "environment",
    );
    expect(keyHint(KEY)).toBe("…wxyz");
    expect(keyHint("short")).toBeNull();
  });

  it("parses --provider api|cli out of the arguments", () => {
    expect(takeProvider(["--limit", "1", "--provider", "cli"])).toEqual({
      provider: "cli",
      args: ["--limit", "1"],
    });
    expect(takeProvider(["--provider=api"])).toEqual({ provider: "api", args: [] });
    expect(takeProvider(["--limit", "2"])).toEqual({ provider: null, args: ["--limit", "2"] });
    expect(() => takeProvider(["--provider", "gpt"])).toThrow(/"api" or "cli"/);
  });
});

describe("spend by provider", () => {
  it("records CLI calls as subscription estimates, apart from API spend", () => {
    const { store } = setup();
    const usage = { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0 };
    store.logLlmCall("draft", "claude-opus-5-5", usage);
    store.logLlmCall("draft", "claude-opus-5-5", usage, false, {
      provider: "cli",
      reportedUsd: 0.5,
    });
    expect(store.costSummary()).toEqual([
      { purpose: "draft", provider: "api", calls: 1, usd: 4 },
      { purpose: "draft", provider: "cli", calls: 1, usd: 0.5 },
    ]);
  });
});

describe("usage limit", () => {
  it("pauses prep at the subscription's limit instead of failing every posting", async () => {
    const { store } = setup();
    const out = mkdtempSync(join(tmpdir(), "ia-out-"));
    dirs.push(out);
    let calls = 0;
    const llm = new FakeLlm({
      draft: () => {
        calls++;
        throw new UsageLimitError("resets at 5pm");
      },
    });
    const d = { store, profile, fetch: routeFetch({}), llm, outDir: out, log: () => {} };
    store.savePostings(
      [1, 2, 3].map((n) => makePosting({ id: `p${n}`, company: `Co ${n}`, title: "SWE Intern" })),
    );
    await runScoring({ ...d, llm: null });
    const r = await runPrep(d, { limit: 3 });
    expect(r).toMatchObject({ prepared: 0, failed: 0, paused: true });
    expect(calls).toBe(1);
    // The unfinished application is kept for the next run.
    expect(store.listApplications().map((a) => a.status)).toEqual(["prepared"]);
  });

  it("scores the rest with keywords once the limit is hit, logging it once", async () => {
    const { store } = setup();
    let calls = 0;
    const logs: string[] = [];
    const llm = new FakeLlm({
      requirements: () => {
        calls++;
        throw new UsageLimitError("resets at 5pm");
      },
    });
    store.savePostings([1, 2, 3].map((n) => makePosting({ id: `p${n}`, company: `Co ${n}` })));
    const r = await runScoring(
      { store, profile, llm, fetch: routeFetch({}), log: (m) => logs.push(m) },
      { concurrency: 1 },
    );
    expect(r.modelCalls).toBe(0);
    expect(calls).toBe(1);
    expect(logs.filter((l) => /usage limit/.test(l))).toHaveLength(1);
  });
});

describe("Settings API", () => {
  function server() {
    const s = setup();
    let reloads = 0;
    const app = buildServer({
      store: s.store,
      profile,
      token: TOKEN,
      outDir: s.paths.out,
      snapshotsDir: s.paths.snapshots,
      uiDir: null,
      allowedHosts: [HOST],
      paths: s.paths,
      env: s.env,
      reloadLlm: () => {
        reloads++;
        return null;
      },
    });
    const call = (method: string, url: string, payload?: object, headers = {}) =>
      app.inject({
        method: method as "GET",
        url,
        ...(payload ? { payload } : {}),
        headers: { host: HOST, "x-ia-token": TOKEN, ...headers },
      });
    return { ...s, app, call, reloads: () => reloads };
  }

  it("shows each provider's status and switches provider", async () => {
    const { call, bin, reloads } = server();
    const first = (await call("GET", "/api/settings/provider")).json();
    expect(first).toMatchObject({
      selected: "api",
      ready: false,
      api: { available: false, source: null, hint: null },
      cli: { found: false },
      labels: { api: "Anthropic API key", cli: "Claude CLI (subscription)" },
    });
    const switched = (
      await call("PUT", "/api/settings/provider", { provider: "cli", cliPath: bin })
    ).json();
    expect(switched).toMatchObject({
      selected: "cli",
      ready: true,
      cli: { found: true, version: "2.1.999", signedIn: true },
    });
    expect(JSON.stringify(switched)).not.toContain("someone@example.com");
    expect(reloads()).toBe(1);
    expect((await call("PUT", "/api/settings/provider", { provider: "gpt" })).statusCode).toBe(400);
  });

  it("tests a connection with one tiny call", async () => {
    const { call, bin } = server();
    expect((await call("POST", "/api/settings/provider/test", { provider: "api" })).json()).toEqual(
      { ok: false, error: expect.stringMatching(/No Anthropic API key/) },
    );
    await call("PUT", "/api/settings/provider", { cliPath: bin });
    expect(
      (await call("POST", "/api/settings/provider/test", { provider: "cli" })).json(),
    ).toMatchObject({ ok: true, model: "claude-haiku-5-5" });
  });

  it("saves a pasted key without ever returning it, and forgets it on request", async () => {
    const { call, paths } = server();
    const saved = await call("PUT", "/api/settings/api-key", { key: KEY });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(KEY);
    expect(saved.json()).toMatchObject({
      api: { available: true, source: "saved", hint: "…wxyz" },
    });
    expect((await call("GET", "/api/settings/provider")).body).not.toContain(KEY.slice(0, -4));
    const bad = await call("PUT", "/api/settings/api-key", { key: "not-a-key" });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain("not-a-key");
    await call("DELETE", "/api/settings/api-key");
    expect(() => statSync(savedKeyPath(paths))).toThrow();
  });

  it("is closed to the extension and to other origins, and needs the token", async () => {
    const { call, app } = server();
    expect(
      (await call("GET", "/api/settings/provider", undefined, { origin: "chrome-extension://x" }))
        .statusCode,
    ).toBe(403);
    expect(
      (await call("PUT", "/api/settings/api-key", { key: KEY }, { origin: "https://evil.test" }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: "/api/settings/provider", headers: { host: HOST } })).statusCode,
    ).toBe(401);
  });
});
