// Commands added by later phases register here, so cli.ts stays small.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { OutcomeReport, Tier } from "@ia/core";
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
    llm: ctx.llm,
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

registerCommand("stats", async (ctx) => {
  const { buildServer } = await import("./api.ts");
  const app = buildServer({
    store: ctx.store,
    profile: ctx.profile,
    token: ctx.token,
    outDir: ctx.paths.out,
    snapshotsDir: ctx.paths.snapshots,
    uiDir: null,
    allowedHosts: ["cli"],
  });
  const res = await app.inject({
    url: "/api/stats",
    headers: { host: "cli", "x-ia-token": ctx.token },
  });
  const s = res.json() as OutcomeReport;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  console.log(`Sent ${s.totals.sent ?? 0}. Statuses: ${JSON.stringify(s.totals)}`);
  for (const [title, rows] of [
    ["By tier", s.byTier],
    ["By score band", s.byScoreBand],
    ["By source", s.bySource],
    ["By ATS", s.byAts],
  ] as const) {
    console.log(`\n${title}`);
    for (const r of rows)
      console.log(
        `  ${r.key.padEnd(16)} ${String(r.submitted).padStart(4)} sent  ${pct(r.rate).padStart(4)} replied  ${pct(r.positiveRate).padStart(4)} OA/interview/offer`,
      );
  }
  if (s.dueSoon.length)
    console.log(
      `\nDue in the next 7 days:\n${s.dueSoon.map((d) => `  ${d.nextActionDue} ${d.company}: ${d.nextAction ?? ""}`).join("\n")}`,
    );
  if (s.suggestions.length)
    console.log(`\nSuggestions:\n${s.suggestions.map((x) => `  ${x.text}`).join("\n")}`);
  await app.close();
});

registerCommand("export", async (ctx, args) => {
  const { values } = parseArgs({
    args,
    options: { out: { type: "string" }, format: { type: "string" } },
    strict: false,
  });
  const { buildServer } = await import("./api.ts");
  const { writeFileSync } = await import("node:fs");
  const app = buildServer({
    store: ctx.store,
    profile: ctx.profile,
    token: ctx.token,
    outDir: ctx.paths.out,
    snapshotsDir: ctx.paths.snapshots,
    uiDir: null,
    allowedHosts: ["cli"],
  });
  const format = values.format === "tsv" ? "tsv" : "csv";
  const res = await app.inject({
    url: `/api/export.csv?format=${format}`,
    headers: { host: "cli", "x-ia-token": ctx.token },
  });
  const out = String(values.out ?? `${ctx.paths.home}/applications.${format}`);
  writeFileSync(out, res.body);
  console.log(`Wrote ${out}. In Google Sheets: File → Import → Upload.`);
  await app.close();
});

registerCommand("email-sync", async (ctx, args) => {
  const { values, positionals } = parseArgs({
    args,
    options: { "dry-run": { type: "boolean" } },
    allowPositionals: true,
    strict: false,
  });
  const path = positionals[0];
  if (!path)
    throw new Error(
      "Usage: npm run ia -- email-sync <export.mbox | folder of .eml files> [--dry-run]",
    );
  const { syncEmails } = await import("./email-sync.ts");
  const r = syncEmails(ctx.store, path, { dryRun: Boolean(values["dry-run"]) });
  console.log(
    `${r.read} emails read, ${r.matched} matched an application, ${r.updated.length} status change(s)${values["dry-run"] ? " (dry run)" : ""}`,
  );
  for (const u of r.updated) console.log(`  ${u.company}: ${u.from} → ${u.to}  ("${u.subject}")`);
});
