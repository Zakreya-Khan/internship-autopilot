// Bundles the extension into dist/, ready for chrome://extensions → "Load unpacked".
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// IA_EXT_OUT: build somewhere else (tests running side by side each build their own copy).
const dist = process.env.IA_EXT_OUT ?? join(root, "dist");
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
// Content scripts are classic scripts, not modules: rebuild those as IIFEs.
for (const name of ["content", "bridge"])
  await build({
    entryPoints: [join(root, "src", `${name}.ts`)],
    outfile: join(dist, `${name}.js`),
    bundle: true,
    format: "iife",
    target: "chrome116",
    sourcemap: true,
    allowOverwrite: true,
    logLevel: "info",
  });
for (const f of readdirSync(join(root, "static"))) cpSync(join(root, "static", f), join(dist, f));
console.log(`Extension built in ${dist}`);
