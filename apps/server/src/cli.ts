import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { resolvePaths } from "./config.ts";
import type { AppContext } from "./context.ts";
import { ensureToken, openContext } from "./context.ts";
import { Store } from "./db.ts";
import type { Provider } from "./provider.ts";
import { isProvider, PROVIDER_LABELS } from "./provider.ts";
import { runEnrichment, runScoring, runSourcing } from "./pipeline.ts";

type Command = (ctx: AppContext, args: string[]) => Promise<void>;

const HELP = `internship-autopilot

Usage: npm run ia -- <command> [options]

Setup
  init                 Create profile.yaml from the example, the data folder and the API token
Phase 0
  source               Poll public sources (GitHub list + your watchlist boards)
  score                Filter and fit-score open postings
  enrich               Fetch descriptions and forms for the best candidates
  refresh              source + score + enrich + score
  list [--tier A|B|C] [--limit N]
                       Show ranked candidates
  check-open [URL ...] [--limit N]
                       Ask each job board whether postings are still open (top N candidates, or
                       the URLs given). Closed ones are recorded and never come back.
  cost                 Model spend so far, by purpose
Phase 1
  prep [--limit N] [--tier A,B] [--sonnet] [--no-open-check]
                       Tailor, truth-check and plan the best unprepared postings. Each posting is
                       checked still open first; closed ones are skipped before any model call.
  serve [--port N] [--auto] [--batch] [--no-open-check]
                       Review UI + extension API on 127.0.0.1 (--auto: refresh + prep every 6 h;
                       --batch: Tier B drafting through the Batch API)
Phase 2
  batch submit [--limit N]
                       Send Tier B drafting to the Message Batches API (half price, up to 24 h)
  batch collect        Finish batches that have ended
Phase 3
  stats                Response rates by tier, score band, source and ATS; what's due; suggestions
  export [--out FILE] [--format csv|tsv]
                       Tracker export for Google Sheets or Excel
  stories [--count N]  Interview story bank (STAR) from your facts, written to data/stories.md.
                       Every number must appear in a fact the story cites.
  outreach <posting id | URL> [--to recruiter|referral]
                       Draft a short message for you to send yourself. Never sent; no LinkedIn.
  email-sync <mbox|folder> [--dry-run]
                       Update statuses from an email export (local only, rule-based)
Options
  --offline            Never call Claude (keyword scoring, no drafting)
  --provider api|cli   How to reach Claude for this run: your Anthropic API key, or the Claude
                       CLI on your subscription. Default: the choice saved in Settings (api).
`;

function pad(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);
}

const commands: Record<string, Command> = {
  async source(ctx) {
    const r = await runSourcing({ ...ctx, fetch });
    console.log(
      `fetched ${r.fetched}, kept ${r.kept}, added ${r.added}, merged ${r.merged}, closed ${r.closed}`,
    );
    for (const e of r.errors) console.warn(`  ! ${e}`);
  },
  async score(ctx) {
    if (!ctx.llm) console.log(`No Claude (${ctx.llmReason}): using keyword scoring.`);
    const r = await runScoring({ ...ctx, fetch, log: console.warn });
    console.log(
      `considered ${r.considered}: passed ${r.passed}, dropped ${r.dropped}; model calls ${r.modelCalls}, reused ${r.reused}`,
    );
  },
  async enrich(ctx) {
    const r = await runEnrichment({ ...ctx, fetch, log: console.warn });
    console.log(`details fetched for ${r.enriched} of ${r.tried} (${r.failed} failed)`);
  },
  async refresh(ctx) {
    // The full Phase 0 loop: poll, score, fetch details for the best, score again with them.
    await commands.source!(ctx, []);
    await commands.score!(ctx, []);
    await commands.enrich!(ctx, []);
    await commands.score!(ctx, []);
  },
  async list(ctx, args) {
    const { values } = parseArgs({
      args,
      options: { tier: { type: "string" }, limit: { type: "string" } },
      allowPositionals: true,
      strict: false,
    });
    const limit = Number(values.limit ?? 30);
    const rows = ctx.store
      .rankedCandidates(5000)
      .filter((r) => !values.tier || r.score.fit?.tier === values.tier)
      .slice(0, limit);
    console.log(`${pad("tier", 5)}${pad("fit", 5)}${pad("company", 24)}${pad("role", 48)}location`);
    for (const { posting: p, score: s } of rows) {
      console.log(
        `${pad(s.fit?.tier ?? "-", 5)}${pad(String(s.fit?.score ?? "-"), 5)}${pad(p.company, 24)}${pad(p.title, 48)}${p.locations.join("; ")}`,
      );
    }
  },
  async cost(ctx) {
    const rows = ctx.store.costSummary();
    if (!rows.length) return console.log("No model calls logged yet.");
    for (const provider of ["api", "cli"] as const) {
      const mine = rows.filter((r) => r.provider === provider);
      if (!mine.length) continue;
      console.log(
        provider === "api"
          ? "Anthropic API (billed to your key)"
          : "Claude CLI (covered by your subscription; amounts are estimates)",
      );
      for (const r of mine)
        console.log(`  ${pad(r.purpose, 16)}${pad(String(r.calls), 8)}$${r.usd.toFixed(2)}`);
      const total = mine.reduce((a, r) => a + r.usd, 0).toFixed(2);
      console.log(provider === "api" ? `  total $${total}` : `  estimated $${total}, not billed`);
    }
  },
};

/** Commands registered by later phases (prep, serve, batch, email-sync, export, stats). */
export function registerCommand(name: string, cmd: Command): void {
  commands[name] = cmd;
}

function init(): void {
  const paths = resolvePaths();
  mkdirSync(paths.home, { recursive: true });
  if (!existsSync(paths.profile)) {
    copyFileSync(resolve("profile.example.yaml"), paths.profile);
    console.log(`Created ${paths.profile}. Fill it in with your own facts before scoring.`);
  } else {
    console.log(`${paths.profile} already exists; left as is.`);
  }
  const store = new Store(paths.db);
  const token = ensureToken(store);
  store.close();
  console.log(`Database: ${paths.db}`);
  console.log(`Extension token (paste into the extension's options page): ${token}`);
}

/** Pull "--provider api|cli" (or "--provider=cli") out of the arguments. */
export function takeProvider(args: string[]): { provider: Provider | null; args: string[] } {
  let provider: Provider | null = null;
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const value =
      a === "--provider" ? (args[++i] ?? "") : a.startsWith("--provider=") ? a.slice(11) : null;
    if (value === null) {
      out.push(a);
      continue;
    }
    if (!isProvider(value)) throw new Error(`--provider must be "api" or "cli", not "${value}"`);
    provider = value;
  }
  return { provider, args: out };
}

export async function main(argv: string[]): Promise<number> {
  await import("./commands.ts");
  const [name, ...rest] = argv;
  if (!name || name === "help" || name === "--help") {
    console.log(HELP);
    return 0;
  }
  if (name === "init") {
    init();
    return 0;
  }
  const cmd = commands[name];
  if (!cmd) {
    console.error(`Unknown command "${name}".\n\n${HELP}`);
    return 1;
  }
  const { provider, args } = takeProvider(rest);
  const ctx = openContext({ offline: args.includes("--offline"), provider });
  if (provider) console.log(`Using ${PROVIDER_LABELS[provider]} for this run.`);
  try {
    await cmd(
      ctx,
      args.filter((a) => a !== "--offline"),
    );
    return 0;
  } finally {
    ctx.store.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
