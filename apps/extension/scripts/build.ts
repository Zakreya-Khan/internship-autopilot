// Bundles the extension into dist/, ready for chrome://extensions → "Load unpacked".
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: ["background", "content", "sidepanel", "options"].map((n) =>
    join(root, "src", `${n}.ts`),
  ),
  outdir: dist,
  bundle: true,
  format: "esm",
  target: "chrome116",
  sourcemap: true,
  logLevel: "info",
});
// Content scripts are classic scripts, not modules: rebuild that one as an IIFE.
await build({
  entryPoints: [join(root, "src", "content.ts")],
  outfile: join(dist, "content.js"),
  bundle: true,
  format: "iife",
  target: "chrome116",
  sourcemap: true,
  allowOverwrite: true,
  logLevel: "info",
});
for (const f of readdirSync(join(root, "static"))) cpSync(join(root, "static", f), join(dist, f));
console.log(`Extension built in ${dist}`);
