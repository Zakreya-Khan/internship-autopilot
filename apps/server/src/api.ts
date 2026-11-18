import { timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import type {
  ApplicationStatus,
  CoverLetterBase,
  OutcomeRow,
  PageField,
  Posting,
  Profile,
} from "@ia/core";
import type { LlmClient } from "@ia/ai";
import { mapFieldsWithModel, testConnection } from "@ia/ai";
import {
  hasBlockingFlags,
  isSubmittedOrLater,
  mapPageFieldsByRules,
  outcomeReport,
  questionKey,
  STATUSES,
  toDelimited,
} from "@ia/core";
import { renderCoverLetterPdf } from "@ia/render";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Paths } from "./config.ts";
import type { ApplicationRow, FieldFillRow, Store } from "./db.ts";
import {
  buildLlm,
  forgetKey,
  isProvider,
  PROVIDER_LABELS,
  providerStatus,
  saveKey,
  saveProviderSettings,
} from "./provider.ts";
import type { LivenessCheck } from "./liveness.ts";
import { ensureOpen, SESSION_RECHECK_MS } from "./liveness.ts";
import { resumePathFor } from "./prep.ts";
import { qualifyCandidates } from "./qualify.ts";

export interface ServerDeps {
  store: Store;
  profile: Profile;
  token: string;
  outDir: string;
  snapshotsDir: string;
  /** Built review UI (apps/ui/dist). Null serves the API only. */
  uiDir: string | null;
  /** Host headers accepted, e.g. ["127.0.0.1:4317", "localhost:4317"]. Blocks DNS rebinding. */
  allowedHosts: string[];
  /** Only used to match fields on pages no adapter knows. Null: rules only. */
  llm?: LlmClient | null;
  /** Where data/ is. Needed for the Settings page (a pasted API key is saved there). */
  paths?: Paths;
  /** Rebuilds the model client after the provider or key changes in Settings. */
  reloadLlm?: () => LlmClient | null;
  /** Environment used for the provider status (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Your own cover letter's greeting and closing, reused when you edit a letter. */
  coverBase?: CoverLetterBase | null;
  /** Rechecks that an approved posting is still open before the session opens it. */
  liveness?: LivenessCheck | null;
  logger?: boolean;
}

class HttpProblem extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const UI_SETTABLE = new Set<ApplicationStatus>(
  STATUSES.filter((s) => !["prepared", "filled", "submitted"].includes(s)),
);

export function flagCounts(fields: FieldFillRow[]) {
  return {
    red: fields.filter((f) => f.flag === "red").length,
    amber: fields.filter((f) => f.flag === "amber").length,
    grey: fields.filter((f) => f.flag === "grey").length,
  };
}

function postingSummary(p: Posting) {
  return {
    id: p.id,
    company: p.company,
    title: p.title,
    locations: p.locations,
    ats: p.ats,
    applyUrl: p.applyUrl,
    deadline: p.deadline,
    sponsorship: p.sponsorship,
    sourceLinks: p.sourceLinks,
  };
}

function fileName(name: string, kind: "resume" | "cover_letter"): string {
  const base = name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "") || "Applicant";
  return `${base}_${kind === "resume" ? "Resume" : "Cover_Letter"}.pdf`;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const { store, profile } = deps;
  let llm = deps.llm ?? null;
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 8 * 1024 * 1024 });

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!deps.allowedHosts.includes(req.headers.host ?? "")) {
      return reply.code(421).send({ error: "unexpected Host header" });
    }
    const origin = req.headers.origin;
    const sameOrigin = deps.allowedHosts.some((h) => origin === `http://${h}`);
    if (origin && origin.startsWith("chrome-extension://")) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
      reply.header("Access-Control-Allow-Headers", "content-type, x-ia-token");
      reply.header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
      if (req.method === "OPTIONS") return reply.code(204).send();
    } else if (origin && !sameOrigin) {
      return reply.code(403).send({ error: "origin not allowed" });
    }
    // Settings (provider, API key) are only for the review UI, never the extension.
    if (req.url.startsWith("/api/settings") && origin && !sameOrigin) {
      return reply.code(403).send({ error: "settings are only available in the review UI" });
    }
    if (req.url.startsWith("/api/") && req.url !== "/api/health") {
      const t = req.headers["x-ia-token"];
      if (typeof t !== "string" || !sameToken(t, deps.token)) {
        return reply.code(401).send({ error: "missing or wrong x-ia-token" });
      }
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const code = err instanceof HttpProblem ? err.statusCode : (err.statusCode ?? 500);
    const message = code >= 500 && !(err instanceof HttpProblem) ? "internal error" : err.message;
    if (code >= 500) app.log.error(err);
    void reply.code(code).send({ error: message });
  });

  const mustApp = (id: string | number): ApplicationRow => {
    const a = store.getApplication(Number(id));
    if (!a) throw new HttpProblem(404, `no application ${id}`);
    return a;
  };
  const postingOf = (a: ApplicationRow): Posting => {
    const p = store.getPosting(a.posting_id);
    if (!p) throw new HttpProblem(404, `no posting ${a.posting_id}`);
    return p;
  };

  /** Needs input → Ready once nothing blocks; Ready → Needs input if something new does. */
  const refreshReadiness = (id: number) => {
    const a = mustApp(id);
    if (a.status !== "needs_input" && a.status !== "ready") return;
    const variant = a.resume_variant_id ? store.getResumeVariant(a.resume_variant_id) : null;
    const parseOk = (variant?.parse_check as { ok?: boolean } | null)?.ok !== false;
    const draftsOk = store.listDrafts(id).every((d) => d.checker_status === "pass");
    const ok = !hasBlockingFlags(store.listFieldFills(id)) && parseOk && draftsOk;
    const want = ok ? "ready" : "needs_input";
    if (a.status !== want) store.setStatus(id, want);
  };

  // ---------- health ----------
  app.get("/api/health", async () => ({ ok: true }));

  // ---------- queue + detail ----------
  app.get<{ Querystring: { status?: string; tier?: string } }>("/api/queue", async (req) => {
    const status = (req.query.status?.split(",") ?? [
      "needs_input",
      "ready",
      "approved",
      "filled",
    ]) as ApplicationStatus[];
    const tier = req.query.tier as "A" | "B" | "C" | undefined;
    return store.listApplications({ status, ...(tier ? { tier } : {}) }).map((a) => {
      const p = postingOf(a);
      return {
        id: a.id,
        status: a.status,
        tier: a.tier,
        score: store.getScore(p.id)?.fit?.score ?? null,
        posting: postingSummary(p),
        flags: flagCounts(store.listFieldFills(a.id)),
        updatedAt: a.updated_at,
      };
    });
  });

  app.get<{ Params: { id: string } }>("/api/applications/:id", async (req) => {
    const a = mustApp(req.params.id);
    const p = postingOf(a);
    const variant = a.resume_variant_id ? store.getResumeVariant(a.resume_variant_id) : null;
    const plan = (variant?.plan ?? null) as { fitNote?: unknown; issues?: unknown } | null;
    const fields = store.listFieldFills(a.id);
    return {
      application: a,
      posting: { ...postingSummary(p), descriptionText: p.descriptionText },
      score: store.getScore(p.id)?.fit ?? null,
      resume: variant
        ? {
            diff: variant.diff,
            parseCheck: variant.parse_check,
            fitNote: plan?.fitNote ?? null,
            issues: plan?.issues ?? [],
            hasCoverLetter: existsSync(resumePathFor(deps.outDir, a.id, "cover_letter")),
          }
        : null,
      drafts: store.listDrafts(a.id),
      fields,
      flags: flagCounts(fields),
      events: store.events(a.id),
    };
  });

  app.get<{ Params: { id: string; kind: string } }>(
    "/api/applications/:id/files/:kind",
    async (req, reply) => {
      const a = mustApp(req.params.id);
      const kind = req.params.kind === "cover_letter" ? "cover_letter" : "resume";
      const path = resumePathFor(deps.outDir, a.id, kind);
      if (!existsSync(path)) throw new HttpProblem(404, `no ${kind} for application ${a.id}`);
      return reply
        .type("application/pdf")
        .header(
          "Content-Disposition",
          `inline; filename="${fileName(profile.identity.name, kind)}"`,
        )
        .send(readFileSync(path));
    },
  );

  // ---------- edits from the review UI ----------
  app.patch<{ Params: { id: string; key: string }; Body: { value: string; remember?: boolean } }>(
    "/api/applications/:id/fields/:key",
    async (req) => {
      const a = mustApp(req.params.id);
      if (!["needs_input", "ready", "approved"].includes(a.status)) {
        throw new HttpProblem(409, `fields are locked once an application is ${a.status}`);
      }
      const field = store.listFieldFills(a.id).find((f) => f.field_key === req.params.key);
      if (!field) throw new HttpProblem(404, `no field ${req.params.key}`);
      const value = String(req.body?.value ?? "");
      store.setFieldByUser(a.id, field.field_key, value);
      if (req.body?.remember !== false && value)
        store.saveLearnedAnswer(questionKey(field.label), field.label, value, a.id);
      store.logEvent(a.id, "field_edited", { key: field.field_key });
      if (a.status === "approved") store.setStatus(a.id, "ready");
      refreshReadiness(a.id);
      return { ok: true, status: mustApp(a.id).status };
    },
  );

  app.patch<{ Params: { id: string }; Body: { text: string } }>("/api/drafts/:id", async (req) => {
    const id = Number(req.params.id);
    const draft = store.db
      .prepare("SELECT application_id, kind, question_key FROM drafts WHERE id = ?")
      .get(id) as { application_id: number; kind: string; question_key: string | null } | undefined;
    if (!draft) throw new HttpProblem(404, `no draft ${id}`);
    const a = mustApp(draft.application_id);
    const text = String(req.body?.text ?? "");
    store.editDraft(id, text);
    if (draft.kind === "answer" && draft.question_key)
      store.setFieldByUser(a.id, draft.question_key, text);
    if (draft.kind === "cover_letter") {
      const p = postingOf(a);
      const pdf = await renderCoverLetterPdf(
        profile.identity.name,
        p.company,
        text.split(/\n{2,}/),
        { greeting: deps.coverBase?.greeting ?? null, closing: deps.coverBase?.closing ?? null },
      );
      writeFileSync(resumePathFor(deps.outDir, a.id, "cover_letter"), pdf);
    }
    store.logEvent(a.id, "draft_edited", { draftId: id });
    if (a.status === "approved") store.setStatus(a.id, "ready");
    refreshReadiness(a.id);
    return { ok: true, status: mustApp(a.id).status };
  });

  app.post<{ Params: { id: string }; Body: { to: ApplicationStatus; confirmedByUser?: boolean } }>(
    "/api/applications/:id/status",
    async (req) => {
      const a = mustApp(req.params.id);
      const to = req.body?.to;
      if (to === "submitted") {
        // Only you can say an application went out, and only after the extension filled it.
        if (!req.body.confirmedByUser)
          throw new HttpProblem(400, "submitted needs confirmedByUser");
      } else if (!UI_SETTABLE.has(to)) {
        throw new HttpProblem(400, `status ${String(to)} can't be set from here`);
      }
      if (to === "approved") {
        const fields = store.listFieldFills(a.id);
        if (a.status !== "ready" || hasBlockingFlags(fields)) {
          throw new HttpProblem(409, "only a Ready application with no red flags can be approved");
        }
      }
      try {
        return { ok: true, application: store.setStatus(a.id, to) };
      } catch (e) {
        throw new HttpProblem(409, (e as Error).message);
      }
    },
  );

  // ---------- submit session (called by the extension) ----------
  app.post<{ Body: { skip?: number[] } }>("/api/session/next", async (req) => {
    const skip = new Set(req.body?.skip ?? []);
    const approved = store
      .listApplications({ status: ["approved"] })
      .filter((a) => !skip.has(a.id))
      .map((a) => ({ a, p: postingOf(a), score: store.getScore(a.posting_id)?.fit?.score ?? 0 }))
      .sort(
        (x, y) =>
          (x.p.deadline ?? "9999").localeCompare(y.p.deadline ?? "9999") || y.score - x.score,
      );
    // A posting can close between approval and the session. Check before opening it; skip and
    // report the ones that closed. An uncertain answer keeps the application.
    const closed: { id: number; company: string; title: string; reason: string }[] = [];
    let next: (typeof approved)[number] | undefined;
    for (const cand of approved) {
      if (deps.liveness) {
        const r = await ensureOpen(store, cand.p, deps.liveness, SESSION_RECHECK_MS);
        if (r.verdict === "expired") {
          store.setStatus(cand.a.id, "skipped");
          store.logEvent(cand.a.id, "posting_closed", { code: r.code, reason: r.reason });
          closed.push({
            id: cand.a.id,
            company: cand.p.company,
            title: cand.p.title,
            reason: r.reason,
          });
          continue;
        }
      }
      next = cand;
      break;
    }
    if (!next) return { done: true, remaining: 0, closed };
    const files: Record<string, { name: string; base64: string }> = {};
    for (const kind of ["resume", "cover_letter"] as const) {
      const path = resumePathFor(deps.outDir, next.a.id, kind);
      if (existsSync(path))
        files[kind] = {
          name: fileName(profile.identity.name, kind),
          base64: readFileSync(path).toString("base64"),
        };
    }
    return {
      done: false,
      remaining: approved.length - closed.length,
      closed,
      application: {
        id: next.a.id,
        applyUrl: next.p.applyUrl,
        ats: next.p.ats,
        company: next.p.company,
        title: next.p.title,
        fields: store.listFieldFills(next.a.id).map((f) => ({
          key: f.field_key,
          label: f.label,
          type: f.field_type,
          value: f.planned_value,
          options: f.options,
          required: f.required,
          attach: f.attach,
          flag: f.flag,
          note: f.note,
        })),
        files,
      },
    };
  });

  app.post<{ Params: { id: string }; Body: { seen?: Record<string, string | null> } }>(
    "/api/applications/:id/filled",
    async (req) => {
      const a = mustApp(req.params.id);
      if (a.status !== "approved" && a.status !== "filled")
        throw new HttpProblem(409, `application is ${a.status}, not approved`);
      const seen = req.body?.seen ?? {};
      store.recordValuesSeen(a.id, seen);
      if (a.status === "approved") store.setStatus(a.id, "filled");
      const mismatches = store
        .listFieldFills(a.id)
        .filter(
          (f) =>
            f.planned_value &&
            f.field_key in seen &&
            (seen[f.field_key] ?? "").trim() !== f.planned_value.trim(),
        )
        .map((f) => ({
          key: f.field_key,
          label: f.label,
          planned: f.planned_value,
          seen: seen[f.field_key] ?? null,
        }));
      store.logEvent(a.id, "filled", { mismatches: mismatches.length });
      return { ok: true, mismatches };
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      detectedBy: "confirmation_page" | "user";
      confirmationUrl?: string;
      snapshotHtml?: string;
    };
  }>("/api/applications/:id/submitted", async (req) => {
    const a = mustApp(req.params.id);
    if (isSubmittedOrLater(a.status)) return { ok: true, application: a };
    if (a.status !== "filled")
      throw new HttpProblem(
        409,
        `application is ${a.status}; only a filled application can be marked submitted`,
      );
    let snapshot: string | undefined;
    if (req.body?.snapshotHtml) {
      mkdirSync(deps.snapshotsDir, { recursive: true });
      snapshot = join(deps.snapshotsDir, `${a.id}.html`);
      writeFileSync(snapshot, req.body.snapshotHtml);
    }
    const updated = store.setStatus(a.id, "submitted", snapshot ? { snapshot_path: snapshot } : {});
    store.logEvent(a.id, "submitted", {
      detectedBy: req.body?.detectedBy ?? "user",
      url: req.body?.confirmationUrl ?? null,
    });
    return { ok: true, application: updated };
  });

  app.post<{ Params: { id: string } }>("/api/applications/:id/abandon", async (req) => {
    const a = mustApp(req.params.id);
    if (a.status !== "filled") throw new HttpProblem(409, `application is ${a.status}, not filled`);
    return { ok: true, application: store.setStatus(a.id, "approved") };
  });

  // ---------- tracker ----------
  app.get("/api/tracker", async () =>
    store
      .listApplications()
      .filter((a) => isSubmittedOrLater(a.status))
      .map((a) => ({ ...a, posting: postingSummary(postingOf(a)) })),
  );

  app.patch<{
    Params: { id: string };
    Body: Partial<Pick<ApplicationRow, "next_action" | "next_action_due" | "contact" | "notes">>;
  }>("/api/applications/:id/tracking", async (req) => {
    const a = mustApp(req.params.id);
    const b = req.body ?? {};
    const allowed = ["next_action", "next_action_due", "contact", "notes"] as const;
    const fields = Object.fromEntries(allowed.filter((k) => k in b).map((k) => [k, b[k] ?? null]));
    store.updateTracking(a.id, fields);
    return { ok: true, application: mustApp(a.id) };
  });

  app.get("/api/cost", async () => store.costSummary());

  // ---------- Settings: how to reach Claude ----------
  const mustPaths = (): Paths => {
    if (!deps.paths) throw new HttpProblem(501, "settings aren't available in this server");
    return deps.paths;
  };
  const settingsView = async () => {
    const status = await providerStatus(store, mustPaths(), deps.env ?? process.env);
    const active = buildLlm({ store, paths: mustPaths(), env: deps.env ?? process.env });
    // A CLI that's installed but signed out can't make calls either.
    const signedOut = status.selected === "cli" && status.cli.signedIn === false;
    return {
      ...status,
      labels: PROVIDER_LABELS,
      ready: active.llm !== null && !signedOut,
      reason: signedOut
        ? 'the Claude CLI isn\'t signed in. Run "claude" once in a terminal and sign in.'
        : active.reason,
    };
  };
  const reload = () => {
    llm = deps.reloadLlm ? deps.reloadLlm() : llm;
  };

  app.get("/api/settings/provider", async () => settingsView());

  app.put<{ Body: { provider?: string; cliPath?: string | null } }>(
    "/api/settings/provider",
    async (req) => {
      const b = req.body ?? {};
      if (b.provider !== undefined && !isProvider(b.provider))
        throw new HttpProblem(400, 'provider must be "api" or "cli"');
      saveProviderSettings(store, {
        ...(b.provider !== undefined ? { provider: b.provider } : {}),
        ...(b.cliPath !== undefined ? { cliPath: b.cliPath } : {}),
      });
      reload();
      return settingsView();
    },
  );

  // One tiny call through the given provider (or the saved one).
  app.post<{ Body: { provider?: string } }>("/api/settings/provider/test", async (req) => {
    const p = req.body?.provider;
    if (p !== undefined && !isProvider(p)) throw new HttpProblem(400, "unknown provider");
    const choice = buildLlm({
      store,
      paths: mustPaths(),
      env: deps.env ?? process.env,
      override: p ?? null,
    });
    if (!choice.llm) return { ok: false, error: choice.reason };
    return testConnection(choice.llm);
  });

  // A pasted key is written to data/ with 0600 permissions and never sent back.
  app.put<{ Body: { key?: string } }>("/api/settings/api-key", async (req) => {
    const key = req.body?.key;
    if (typeof key !== "string" || !key.trim()) throw new HttpProblem(400, "no key given");
    try {
      saveKey(mustPaths(), key);
    } catch (e) {
      throw new HttpProblem(400, e instanceof Error ? e.message : "invalid key");
    }
    reload();
    return settingsView();
  });

  app.delete("/api/settings/api-key", async () => {
    forgetKey(mustPaths());
    reload();
    return settingsView();
  });

  // ---------- Phase 3: unknown sites, export, outcomes ----------
  app.post<{ Params: { id: string }; Body: { fields: PageField[] } }>(
    "/api/applications/:id/map-fields",
    async (req) => {
      const a = mustApp(req.params.id);
      if (!["approved", "filled"].includes(a.status))
        throw new HttpProblem(409, `application is ${a.status}`);
      const page = (req.body?.fields ?? []).slice(0, 200);
      const plan = store.listFieldFills(a.id).map((f) => ({
        key: f.field_key,
        label: f.label,
        value: f.planned_value,
        attach: f.attach,
      }));
      const { mapped, unmatched } = mapPageFieldsByRules(page, plan, profile);
      if (llm && unmatched.length) {
        try {
          const matches = await mapFieldsWithModel(llm, unmatched, plan);
          const byKey = new Map(plan.map((p) => [p.key, p]));
          for (const f of unmatched) {
            const p = matches.get(f.key) ? byKey.get(matches.get(f.key)!) : undefined;
            mapped.push({
              ...f,
              options: f.options ?? null,
              value: p?.value ?? null,
              attach: p?.attach ?? null,
              via: p ? "model" : "none",
            });
          }
        } catch {
          for (const f of unmatched)
            mapped.push({ ...f, options: f.options ?? null, value: null, via: "none" });
        }
      } else {
        for (const f of unmatched)
          mapped.push({ ...f, options: f.options ?? null, value: null, via: "none" });
      }
      store.logEvent(a.id, "generic_map", {
        page: page.length,
        filled: mapped.filter((m) => m.value || m.attach).length,
      });
      return { fields: mapped };
    },
  );

  const outcomeRows = (): (OutcomeRow & { appliedUrl: string; locations: string })[] =>
    store.listApplications().map((a) => {
      const p = postingOf(a);
      return {
        id: a.id,
        company: p.company,
        title: p.title,
        status: a.status,
        tier: a.tier,
        score: store.getScore(p.id)?.fit?.score ?? null,
        ats: p.ats,
        sources: p.sources,
        roleFamily: p.roleFamily,
        submittedAt: a.submitted_at,
        nextAction: a.next_action,
        nextActionDue: a.next_action_due,
        contact: a.contact,
        appliedUrl: p.applyUrl,
        locations: p.locations.join("; "),
      };
    });

  app.get<{ Querystring: { format?: string } }>("/api/export.csv", async (req, reply) => {
    const tsv = req.query.format === "tsv";
    const cols = [
      "id",
      "company",
      "title",
      "status",
      "tier",
      "score",
      "ats",
      "locations",
      "submittedAt",
      "nextAction",
      "nextActionDue",
      "contact",
      "appliedUrl",
    ];
    const body = toDelimited(outcomeRows(), cols, tsv ? "\t" : ",");
    return reply
      .type(tsv ? "text/tab-separated-values; charset=utf-8" : "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="applications.${tsv ? "tsv" : "csv"}"`)
      .send(body);
  });

  app.get("/api/stats", async () => ({
    ...outcomeReport(outcomeRows()),
    cost: store.costSummary(),
  }));

  // ---------- do I meet the minimums? ----------
  app.get<{ Querystring: { verdict?: string; tier?: string } }>("/api/qualify", async (req) => {
    const verdict = req.query.verdict === "close" ? "close" : "meets";
    const tier = req.query.tier as "A" | "B" | "C" | undefined;
    return qualifyCandidates(store, deps.profile, { verdict, ...(tier ? { tier } : {}) });
  });

  // ---------- review UI ----------
  if (deps.uiDir && existsSync(join(deps.uiDir, "index.html"))) {
    const indexHtml = readFileSync(join(deps.uiDir, "index.html"), "utf8").replace(
      "</head>",
      `<meta name="ia-token" content="${deps.token}"></head>`,
    );
    void app.register(fastifyStatic, {
      root: deps.uiDir,
      index: false,
      wildcard: false,
      prefix: "/",
    });
    app.get("/", async (_req, reply) =>
      reply.type("text/html").header("Cache-Control", "no-store").send(indexHtml),
    );
  }

  return app;
}
