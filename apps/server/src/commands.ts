// Commands added by later phases register here, so cli.ts stays small.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Tier } from "@ia/core";
import { MODELS } from "@ia/ai";
import { POLL_INTERVAL_MS } from "@ia/sources";
import { buildServer } from "./api.ts";
import { registerCommand } from "./cli.ts";
import { DEFAULT_PORT, HOST } from "./config.ts";
import type { AppContext } from "./context.ts";
import { runEnrichment, runScoring, runSourcing } from "./pipeline.ts";
import type { PrepDeps } from "./prep.ts";
import { runPrep } from "./prep.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const UI_DIST = resolve(here, "../../ui/dist");

export function prepDeps(ctx: AppContext, opts: { sonnetForTierB?: boolean } = {}): PrepDeps {
  return {
    ...ctx,
    fetch,
    outDir: ctx.paths.out,
    log: console.warn,
    ...(opts.sonnetForTierB ? { tierBModel: MODELS.sonnet } : {}),
  };
}

registerCommand("prep", async (ctx, args) => {
  const { values } = parseArgs({
    args,
    options: { limit: { type: "string" }, tier: { type: "string" }, sonnet: { type: "boolean" } },
    strict: false,
  });
  if (!ctx.llm)
    console.log(
      "No Claude credentials (or --offline): base resume only, open questions left for you.",
    );
  const tiers = values.tier ? (String(values.tier).split(",") as Tier[]) : undefined;
  const r = await runPrep(prepDeps(ctx, { sonnetForTierB: Boolean(values.sonnet) }), {
    limit: Number(values.limit ?? 10),
    ...(tiers ? { tiers } : {}),
  });
  console.log(
    `prepared ${r.prepared}: ${r.ready} ready, ${r.needsInput} need input, ${r.failed} failed`,
  );
});

registerCommand("serve", async (ctx, args) => {
  const { values } = parseArgs({
    args,
    options: { port: { type: "string" }, auto: { type: "boolean" } },
    strict: false,
  });
  const port = Number(values.port ?? DEFAULT_PORT);
  const uiDir = existsSync(UI_DIST) ? UI_DIST : null;
  const app = buildServer({
    store: ctx.store,
    profile: ctx.profile,
    token: ctx.token,
    outDir: ctx.paths.out,
    snapshotsDir: ctx.paths.snapshots,
    uiDir,
    allowedHosts: [`${HOST}:${port}`, `localhost:${port}`],
  });
  await app.listen({ host: HOST, port });
  console.log(
    `Review UI: http://${HOST}:${port}/${uiDir ? "" : "  (UI not built: run npm run build)"}`,
  );
  if (values.auto) {
    const cycle = async () => {
      try {
        const deps = prepDeps(ctx);
        await runSourcing(deps);
        await runScoring(deps);
        await runEnrichment(deps);
        await runScoring(deps);
        await runPrep(deps, { limit: 25 });
      } catch (e) {
        console.error(`background cycle failed: ${String(e)}`);
      }
    };
    void cycle();
    setInterval(() => void cycle(), POLL_INTERVAL_MS).unref();
    console.log("Auto mode: sourcing, scoring and prep every 6 hours. Nothing is ever submitted.");
  }
  await new Promise<void>((done) => {
    const stop = () => void app.close().then(done);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
});
