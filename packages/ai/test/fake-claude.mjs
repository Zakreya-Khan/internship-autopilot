// A stand-in for the Claude Code CLI, used by tests (copied to a temp folder as `claude`).
// It records each run (argv, stdin, cwd, what's in the cwd, which credential variables it saw)
// to FAKE_CLAUDE_LOG and answers according to FAKE_CLAUDE_MODE. It never calls anything.
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const env = process.env;
const log = env.FAKE_CLAUDE_LOG;
const priorRuns =
  log && existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;

if (argv[0] === "--version") {
  process.stdout.write("2.1.999 (Claude Code)\n");
  process.exit(0);
}
if (argv[0] === "auth") {
  // Real output can include account details; the app must not pass them on.
  const loggedIn = env.FAKE_CLAUDE_MODE !== "logged-out";
  process.stdout.write(
    JSON.stringify({
      loggedIn,
      authMethod: loggedIn ? "claude.ai" : "none",
      email: "someone@example.com",
      orgName: "Example Org",
    }),
  );
  process.exit(0);
}

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  if (log) {
    appendFileSync(
      log,
      `${JSON.stringify({
        argv,
        stdin,
        cwd: process.cwd(),
        cwdEntries: readdirSync(process.cwd()),
        sawCredentials: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"].filter(
          (k) => k in env,
        ),
      })}\n`,
    );
  }
  const schema = JSON.parse(argv[argv.indexOf("--json-schema") + 1] ?? "{}");
  const keys = Object.keys(schema.properties ?? {});
  const answers = env.FAKE_CLAUDE_ANSWERS
    ? JSON.parse(readFileSync(env.FAKE_CLAUDE_ANSWERS, "utf8"))
    : {};
  const answer = answers[keys.find((k) => k in answers) ?? ""] ?? { ok: true };
  const model = argv[argv.indexOf("--model") + 1];
  const base = {
    type: "result",
    subtype: "success",
    total_cost_usd: 0.0123,
    usage: { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 100 },
    modelUsage: { [model]: {} },
    stop_reason: "end_turn",
  };
  const out = (o) => process.stdout.write(JSON.stringify({ ...base, ...o }));
  switch (env.FAKE_CLAUDE_MODE ?? "ok") {
    case "fenced":
      return out({ is_error: false, result: "```json\n" + JSON.stringify(answer) + "\n```" });
    case "bad-then-good":
      return priorRuns === 0
        ? out({ is_error: false, structured_output: { nope: 1 } })
        : out({ is_error: false, structured_output: answer });
    case "always-bad":
      return out({ is_error: false, structured_output: { nope: 1 } });
    case "limit":
      return out({ is_error: true, result: "Claude AI usage limit reached|1700000000" });
    case "logged-out":
      return out({ is_error: true, result: "Not logged in · Please run /login" });
    case "crash":
      process.stderr.write("boom\n");
      process.exit(2);
      break;
    default:
      return out({ is_error: false, structured_output: answer });
  }
});
