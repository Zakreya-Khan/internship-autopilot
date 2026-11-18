import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AnthropicLlm,
  anthropicClient,
  ClaudeCliLlm,
  claudeCliStatus,
  findClaudeCli,
  hasAnthropicCredentials,
} from "@ia/ai";
import type { CliStatus, LlmClient, UsageSink } from "@ia/ai";
import type { Paths } from "./config.ts";
import type { Store } from "./db.ts";

/** How internship-autopilot reaches Claude: the Anthropic API, or the Claude CLI (subscription). */
export type Provider = "api" | "cli";
export const PROVIDERS: Provider[] = ["api", "cli"];

export function isProvider(x: unknown): x is Provider {
  return x === "api" || x === "cli";
}

export interface ProviderSettings {
  provider: Provider;
  /** A specific `claude` binary; null finds it on PATH or in the usual install folders. */
  cliPath: string | null;
}

/** The saved choice. It lives in the local database under data/, never in profile.yaml. */
export function readProviderSettings(store: Store): ProviderSettings {
  const p = store.getMeta("llm_provider");
  return {
    provider: isProvider(p) ? p : "api",
    cliPath: store.getMeta("claude_cli_path") || null,
  };
}

export function saveProviderSettings(store: Store, s: Partial<ProviderSettings>): void {
  if (s.provider !== undefined) {
    if (!isProvider(s.provider)) throw new Error(`Unknown provider "${String(s.provider)}"`);
    store.setMeta("llm_provider", s.provider);
  }
  if (s.cliPath !== undefined) store.setMeta("claude_cli_path", s.cliPath?.trim() ?? "");
}

/** A key pasted into the review UI. Gitignored (under data/) and readable only by you (0600). */
export function savedKeyPath(paths: Paths): string {
  return join(paths.home, "anthropic-api-key");
}

export function readSavedKey(paths: Paths): string | null {
  const p = savedKeyPath(paths);
  if (!existsSync(p)) return null;
  const k = readFileSync(p, "utf8").trim();
  return k || null;
}

export function saveKey(paths: Paths, key: string): void {
  const k = key.trim();
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k))
    throw new Error("That doesn't look like an Anthropic API key (it starts with sk-ant-).");
  const p = savedKeyPath(paths);
  writeFileSync(p, `${k}\n`, { mode: 0o600 });
  chmodSync(p, 0o600);
}

export function forgetKey(paths: Paths): void {
  rmSync(savedKeyPath(paths), { force: true });
}

/** Where the API key comes from. The environment wins over a saved key. */
export function apiKeySource(
  paths: Paths,
  env: NodeJS.ProcessEnv,
): { source: "environment" | "saved" | null; key: string | null } {
  if (hasAnthropicCredentials(env))
    return { source: "environment", key: env.ANTHROPIC_API_KEY ?? null };
  const saved = readSavedKey(paths);
  return saved ? { source: "saved", key: saved } : { source: null, key: null };
}

/** At most the last 4 characters of a key, for display. */
export function keyHint(key: string | null): string | null {
  return key && key.length > 12 ? `…${key.slice(-4)}` : null;
}

export interface LlmChoice {
  provider: Provider;
  llm: LlmClient | null;
  /** Why there is no model, when there isn't one. */
  reason: string | null;
}

export function usageSink(store: Store): UsageSink {
  return ({ purpose, model, usage, provider, reportedUsd }) =>
    store.logLlmCall(purpose, model, usage, false, {
      ...(provider ? { provider } : {}),
      ...(reportedUsd !== undefined ? { reportedUsd } : {}),
    });
}

/** Build the model client for the chosen provider (the --provider flag overrides the saved one). */
export function buildLlm(opts: {
  store: Store;
  paths: Paths;
  env?: NodeJS.ProcessEnv;
  override?: Provider | null;
}): LlmChoice {
  const env = opts.env ?? process.env;
  const saved = readProviderSettings(opts.store);
  const provider = opts.override ?? saved.provider;
  const sink = usageSink(opts.store);
  if (provider === "cli") {
    const bin = findClaudeCli(saved.cliPath, env);
    if (!bin)
      return {
        provider,
        llm: null,
        reason: saved.cliPath
          ? `No runnable Claude CLI at ${saved.cliPath}.`
          : "The Claude CLI (claude) wasn't found. Install Claude Code or set its path in Settings.",
      };
    return { provider, llm: new ClaudeCliLlm(bin, sink, { env }), reason: null };
  }
  const { source, key } = apiKeySource(opts.paths, env);
  if (!source)
    return {
      provider,
      llm: null,
      reason: "No Anthropic API key (set ANTHROPIC_API_KEY, or paste one in Settings).",
    };
  const client = source === "saved" ? anthropicClient(key) : anthropicClient();
  return { provider, llm: new AnthropicLlm(client, sink), reason: null };
}

export interface ProviderStatus {
  selected: Provider;
  cliPath: string | null;
  api: { available: boolean; source: "environment" | "saved" | null; hint: string | null };
  cli: CliStatus;
}

/** What each provider can do right now. Never includes a full key or any account details. */
export async function providerStatus(
  store: Store,
  paths: Paths,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderStatus> {
  const s = readProviderSettings(store);
  const { source, key } = apiKeySource(paths, env);
  return {
    selected: s.provider,
    cliPath: s.cliPath,
    api: { available: source !== null, source, hint: keyHint(key) },
    cli: await claudeCliStatus(s.cliPath, env),
  };
}

export const PROVIDER_LABELS: Record<Provider, string> = {
  api: "Anthropic API key",
  cli: "Claude CLI (subscription)",
};
