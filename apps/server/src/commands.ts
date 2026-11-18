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
    options: { port: { type: "string" }, auto: { type: "boolean" }, batch: { type: "boolean" } },
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
        if (values.batch && ctx.llm) {
          // Tier A live at high effort; Tier B overnight through the Batch API at half price.
          const { AnthropicBatchClient } = await import("@ia/ai");
          const { collectPrepBatches, submitPrepBatch } = await import("./batch.ts");
          const client = new AnthropicBatchClient();
          await collectPrepBatches(deps, client);
          await runPrep(deps, { limit: 25, tiers: ["A"] });
          await submitPrepBatch(deps, client, { limit: 100 });
        } else {
          await runPrep(deps, { limit: 25 });
        }
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

registerCommand("batch", async (ctx, args) => {
  const [sub, ...rest] = args;
  if (!ctx.llm) throw new Error("The Batch API needs Claude credentials (ANTHROPIC_API_KEY).");
  const { AnthropicBatchClient } = await import("@ia/ai");
  const { collectPrepBatches, submitPrepBatch } = await import("./batch.ts");
  const client = new AnthropicBatchClient();
  const deps = prepDeps(ctx);
  if (sub === "submit") {
    const { values } = parseArgs({
      args: rest,
      options: { limit: { type: "string" } },
      strict: false,
    });
    const r = await submitPrepBatch(deps, client, { limit: Number(values.limit ?? 100) });
    console.log(
      r.batchId ? `submitted ${r.count} Tier B drafts as batch ${r.batchId}` : "nothing to batch",
    );
  } else if (sub === "collect") {
    const r = await collectPrepBatches(deps, client);
    console.log(
      `${r.batches} open batch(es): ${r.pending} still running, ${r.completed} finished, ${r.failed} failed`,
    );
  } else {
    console.log("Usage: npm run ia -- batch submit [--limit N] | batch collect");
  }
});
