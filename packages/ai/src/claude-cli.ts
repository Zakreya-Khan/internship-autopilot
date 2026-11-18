import { spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { TokenUsage } from "@ia/core";
import type { LlmClient, LlmRequest, LlmResult, UsageSink } from "./client.ts";

/**
 * Calls Claude through the Claude Code CLI (`claude -p`), on the user's Claude subscription.
 *
 * It gets exactly the request the API path gets (the same system text, built from
 * `profileForModel`, and the same user text), and runs with:
 * - an argv array, never a shell string;
 * - no tools, no MCP servers, no settings files, and no saved session;
 * - an empty temp folder as its working directory, so no CLAUDE.md or project file is read;
 * - API credentials removed from its environment, so it uses the subscription sign-in.
 */

/** Environment variables removed before running the CLI, so it signs in with the subscription. */
const STRIPPED_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDECODE",
];

export function cliEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of STRIPPED_ENV) delete out[k];
  return out;
}

/** The subscription's usage limit was hit. Calls stop until it resets; nothing retries. */
export class UsageLimitError extends Error {
  constructor(detail: string) {
    super(
      `Your Claude subscription's usage limit was reached (${detail}). Paused until it resets.`,
    );
  }
}

/** The CLI isn't installed, or isn't signed in. */
export class CliUnavailableError extends Error {}

const USAGE_LIMIT =
  /usage limit|limit reached|hit your limit|out of (extra )?usage|rate.?limit|resets? (at|in)\b/i;
const NOT_SIGNED_IN = /not logged in|please run \/login|invalid api key|authenticat|oauth/i;

/** Where the CLI usually lives when it isn't on PATH. */
function commonLocations(home: string): string[] {
  return [
    join(home, ".local", "bin", "claude"),
    join(home, ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The `claude` binary to use: an explicit path, then PATH, then the usual install locations. */
export function findClaudeCli(
  explicit: string | null = null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (explicit) return executable(explicit) ? explicit : null;
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const p = join(dir, "claude");
    if (executable(p)) return p;
  }
  return commonLocations(env.HOME ?? homedir()).find(executable) ?? null;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the CLI in a fresh empty folder with the given argv and stdin; the folder is removed after. */
export function runClaude(
  bin: string,
  args: string[],
  opts: { stdin?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<RunResult> {
  const cwd = mkdtempSync(join(tmpdir(), "ia-claude-"));
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: cliEnv(opts.env),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs ?? 10 * 60_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new CliUnavailableError(`Could not run the Claude CLI at ${bin}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(opts.stdin ?? "");
  }).finally(() => rmSync(cwd, { recursive: true, force: true }));
}

/** The argv for one request. The user text goes on stdin, not here. */
export function cliArgs<T>(req: LlmRequest<T>): string[] {
  const schema = zodOutputFormat(req.schema as never).schema;
  return [
    "-p",
    "--output-format",
    "json",
    "--model",
    req.model,
    "--effort",
    req.effort,
    "--system-prompt",
    req.system,
    "--json-schema",
    JSON.stringify(schema),
    "--tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--no-session-persistence",
  ];
}

interface CliJson {
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
}

/** The answer's JSON: the structured output, or the result text (code fences allowed). */
function answerOf(out: CliJson): unknown {
  if (out.structured_output !== undefined && out.structured_output !== null)
    return out.structured_output;
  const text = (out.result ?? "").trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  return JSON.parse(fenced ? fenced[1]! : text);
}

/** Turn a CLI error message into the right error: usage limit, not signed in, or other. */
export function cliError(message: string): Error {
  if (USAGE_LIMIT.test(message)) return new UsageLimitError(message);
  if (NOT_SIGNED_IN.test(message))
    return new CliUnavailableError(
      `The Claude CLI isn't signed in (${message}). Run "claude" once in a terminal and sign in.`,
    );
  return new Error(`Claude CLI: ${message}`);
}

export class ClaudeCliLlm implements LlmClient {
  /** Set once the usage limit is hit: every later call fails at once, without running the CLI. */
  private limited: UsageLimitError | null = null;

  constructor(
    readonly bin: string,
    private readonly onUsage?: UsageSink,
    private readonly opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
  ) {}

  async generate<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    if (this.limited) throw this.limited;
    const args = cliArgs(req);
    let lastProblem = "";
    // One retry when the answer doesn't match the schema; errors from the CLI are never retried.
    for (let attempt = 0; attempt < 2; attempt++) {
      const run = await runClaude(this.bin, args, { stdin: req.user, ...this.opts });
      let out: CliJson;
      try {
        out = JSON.parse(run.stdout) as CliJson;
      } catch {
        const msg = (run.stderr || run.stdout).trim().slice(0, 300) || `exit code ${run.code}`;
        throw this.remember(cliError(msg));
      }
      if (out.is_error)
        throw this.remember(cliError((out.result ?? "unknown error").slice(0, 300)));
      const usage: TokenUsage = {
        input_tokens: out.usage?.input_tokens ?? 0,
        output_tokens: out.usage?.output_tokens ?? 0,
        cache_read_input_tokens: out.usage?.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: out.usage?.cache_creation_input_tokens ?? 0,
      };
      const model = Object.keys(out.modelUsage ?? {})[0] ?? req.model;
      this.onUsage?.({
        purpose: req.purpose,
        model,
        usage,
        provider: "cli",
        ...(typeof out.total_cost_usd === "number" ? { reportedUsd: out.total_cost_usd } : {}),
      });
      try {
        const data = req.schema.parse(answerOf(out));
        return { data, usage, model, stopReason: out.stop_reason ?? "end_turn" };
      } catch (e) {
        lastProblem = e instanceof Error ? e.message.slice(0, 200) : String(e);
      }
    }
    throw new Error(`The Claude CLI's answer didn't match the expected format: ${lastProblem}`);
  }

  private remember(e: Error): Error {
    if (e instanceof UsageLimitError) this.limited = e;
    return e;
  }
}

export interface CliStatus {
  found: boolean;
  path: string | null;
  version: string | null;
  signedIn: boolean | null;
  /** How the CLI is signed in ("claude.ai", "api key"…). Never an email or account name. */
  authMethod: string | null;
  problem: string | null;
}

/** Is the CLI installed, which version, and is it signed in? Reads no account details. */
export async function claudeCliStatus(
  explicit: string | null = null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CliStatus> {
  const path = findClaudeCli(explicit, env);
  if (!path)
    return {
      found: false,
      path: null,
      version: null,
      signedIn: null,
      authMethod: null,
      problem: explicit
        ? `No runnable Claude CLI at ${explicit}.`
        : "The claude command wasn't found on PATH or in the usual install folders.",
    };
  try {
    const v = await runClaude(path, ["--version"], { env, timeoutMs: 20_000 });
    const version = /(\d+\.\d+\.\d+)/.exec(v.stdout)?.[1] ?? null;
    const a = await runClaude(path, ["auth", "status", "--json"], { env, timeoutMs: 20_000 });
    let signedIn: boolean | null = null;
    let authMethod: string | null = null;
    try {
      const j = JSON.parse(a.stdout) as { loggedIn?: boolean; authMethod?: string };
      signedIn = typeof j.loggedIn === "boolean" ? j.loggedIn : null;
      authMethod = typeof j.authMethod === "string" ? j.authMethod : null;
    } catch {
      // Older CLIs have no `auth status`; "Test connection" will tell.
    }
    return {
      found: true,
      path,
      version,
      signedIn,
      authMethod,
      problem:
        signedIn === false ? 'Not signed in. Run "claude" once in a terminal and sign in.' : null,
    };
  } catch (e) {
    return {
      found: true,
      path,
      version: null,
      signedIn: null,
      authMethod: null,
      problem: e instanceof Error ? e.message : String(e),
    };
  }
}
