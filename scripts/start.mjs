#!/usr/bin/env node
// `npm start` (and the double-clickable "Start Internship Autopilot.command"): build what's
// missing or out of date, start the local server on 127.0.0.1, and open the review UI.
// If it's already running, just open the browser. Ctrl-C (or closing the window) stops it.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const PORT = Number(process.env.IA_PORT ?? 4317);
const URL = `http://127.0.0.1:${PORT}/`;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const say = (msg) => console.log(`\n▸ ${msg}`);
function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\n${cmd} ${args.join(" ")} failed. Fix the error above, then start again.`);
    process.exit(r.status ?? 1);
  }
}

/** Newest modification time of any file under these paths. */
function newest(paths) {
  let t = 0;
  const walk = (p) => {
    if (!existsSync(p)) return;
    const s = statSync(p);
    if (s.isDirectory()) {
      for (const f of readdirSync(p)) if (f !== "node_modules" && f !== "dist") walk(join(p, f));
    } else t = Math.max(t, s.mtimeMs);
  };
  for (const p of paths) walk(p);
  return t;
}
const stale = (built, sources) => !existsSync(built) || statSync(built).mtimeMs < newest(sources);

function openBrowser(url) {
  if (process.env.IA_NO_OPEN) return; // tests and remote use: start without opening a browser
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
}

async function healthy() {
  try {
    const r = await fetch(`${URL}api/health`, { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch {
    return false;
  }
}

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Node ${process.versions.node} is too old: install Node 22.13 or newer.`);
  process.exit(1);
}

if (await healthy()) {
  say(`Already running. Opening ${URL}`);
  openBrowser(URL);
  process.exit(0);
}

if (!existsSync(join(root, "node_modules"))) {
  say("First run: installing dependencies (a minute or two)…");
  run(npm, ["install"]);
}

if (!existsSync(join(root, process.env.IA_PROFILE ?? "profile.yaml"))) {
  say("No profile.yaml yet: creating one from the example.");
  run(npm, ["run", "--silent", "ia", "--", "init"]);
  console.log(
    "\nFill in profile.yaml with your own facts (it's open in your editor), then start again.",
  );
  if (process.platform === "darwin") spawn("open", ["-t", "profile.yaml"], { stdio: "ignore" });
  process.exit(0);
}

const ui = ["apps/ui/src", "apps/ui/index.html", "packages/core/src"];
if (stale("apps/ui/dist/index.html", ui)) {
  say("Building the review UI…");
  run(npm, ["run", "build", "-w", "@ia/ui"]);
}
const ext = ["apps/extension/src", "apps/extension/static", "packages/adapters/src"];
if (stale("apps/extension/dist/manifest.json", ext)) {
  say("Building the browser extension… (reload it in chrome://extensions afterwards)");
  run(npm, ["run", "build", "-w", "@ia/extension"]);
}

say(`Starting on ${URL} (this computer only). Press Ctrl-C or close this window to stop.`);
const server = spawn(
  process.execPath,
  [
    join(root, "node_modules/tsx/dist/cli.mjs"),
    "apps/server/src/cli.ts",
    "serve",
    "--port",
    String(PORT),
  ],
  { stdio: "inherit" },
);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => server.kill("SIGTERM"));
server.on("exit", (code) => process.exit(code ?? 0));

for (let i = 0; i < 60; i++) {
  if (await healthy()) {
    openBrowser(URL);
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}
