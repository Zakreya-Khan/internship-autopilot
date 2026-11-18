import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ApplicationStatus,
  Confidence,
  FillEntry,
  FillSource,
  FitScore,
  Flag,
  FormQuestion,
  Posting,
  Tier,
  TokenUsage,
} from "@ia/core";
import { assertTransition, costUsd, normalizeCompany } from "@ia/core";

/** Each entry runs once, in order; `PRAGMA user_version` records how far a database has got. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE postings (
    id TEXT PRIMARY KEY,
    company TEXT NOT NULL,
    company_norm TEXT NOT NULL,
    title TEXT NOT NULL,
    role_family TEXT NOT NULL,
    ats TEXT NOT NULL,
    apply_url TEXT NOT NULL,
    is_open INTEGER NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX postings_company ON postings(company_norm);
  CREATE TABLE fit_scores (
    posting_id TEXT PRIMARY KEY REFERENCES postings(id) ON DELETE CASCADE,
    passed INTEGER NOT NULL,
    filter_reasons TEXT NOT NULL,
    score INTEGER,
    tier TEXT,
    components TEXT,
    match TEXT,
    input_hash TEXT NOT NULL,
    scored_at TEXT NOT NULL
  );
  CREATE TABLE applications (
    id INTEGER PRIMARY KEY,
    posting_id TEXT NOT NULL UNIQUE REFERENCES postings(id),
    tier TEXT NOT NULL,
    status TEXT NOT NULL,
    approved_at TEXT,
    filled_at TEXT,
    submitted_at TEXT,
    snapshot_path TEXT,
    resume_variant_id INTEGER,
    next_action TEXT,
    next_action_due TEXT,
    contact TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE resume_variants (
    id INTEGER PRIMARY KEY,
    application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    plan TEXT NOT NULL,
    pdf_path TEXT,
    diff TEXT,
    parse_check TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE drafts (
    id INTEGER PRIMARY KEY,
    application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    question_key TEXT,
    question_text TEXT,
    text TEXT NOT NULL,
    cited_fact_ids TEXT NOT NULL,
    checker_status TEXT NOT NULL,
    checker_notes TEXT NOT NULL,
    edited_by_user INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE field_fills (
    id INTEGER PRIMARY KEY,
    application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    field_key TEXT NOT NULL,
    label TEXT NOT NULL,
    field_type TEXT NOT NULL,
    planned_value TEXT,
    source TEXT NOT NULL,
    confidence TEXT NOT NULL,
    flag TEXT,
    value_seen TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (application_id, field_key)
  );
  CREATE TABLE learned_answers (
    id INTEGER PRIMARY KEY,
    question_key TEXT NOT NULL UNIQUE,
    question_text TEXT NOT NULL,
    answer TEXT NOT NULL,
    from_application_id INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    application_id INTEGER,
    at TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE TABLE llm_calls (
    id INTEGER PRIMARY KEY,
    purpose TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    cached_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    batch INTEGER NOT NULL DEFAULT 0,
    at TEXT NOT NULL
  );
  CREATE TABLE poll_runs (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    source TEXT NOT NULL,
    ok INTEGER NOT NULL,
    error TEXT,
    count INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE batches (
    id TEXT PRIMARY KEY,
    purpose TEXT NOT NULL,
    status TEXT NOT NULL,
    application_ids TEXT NOT NULL,
    created_at TEXT NOT NULL,
    collected_at TEXT
  );
  `,
  `
  ALTER TABLE field_fills ADD COLUMN note TEXT;
  ALTER TABLE field_fills ADD COLUMN required INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE field_fills ADD COLUMN options TEXT;
  ALTER TABLE field_fills ADD COLUMN attach TEXT;
  `,
  `
  CREATE TABLE liveness_checks (
    posting_id TEXT PRIMARY KEY REFERENCES postings(id) ON DELETE CASCADE,
    verdict TEXT NOT NULL,
    code TEXT NOT NULL,
    reason TEXT NOT NULL,
    via TEXT NOT NULL,
    checked_at TEXT NOT NULL
  );
  `,
];

export interface LivenessRow {
  posting_id: string;
  verdict: "active" | "expired" | "uncertain";
  code: string;
  reason: string;
  via: string;
  checked_at: string;
}

export type Row = Record<string, unknown>;

export interface ApplicationRow {
  id: number;
  posting_id: string;
  tier: Tier;
  status: ApplicationStatus;
  approved_at: string | null;
  filled_at: string | null;
  submitted_at: string | null;
  snapshot_path: string | null;
  resume_variant_id: number | null;
  next_action: string | null;
  next_action_due: string | null;
  contact: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScoreRow {
  posting_id: string;
  passed: boolean;
  filter_reasons: string[];
  fit: FitScore | null;
  input_hash: string;
  scored_at: string;
}

export interface FieldFillRow {
  application_id: number;
  field_key: string;
  label: string;
  field_type: FormQuestion["type"];
  planned_value: string | null;
  source: FillSource;
  confidence: Confidence;
  flag: Flag;
  note: string | null;
  required: boolean;
  options: string[] | null;
  attach: "resume" | "cover_letter" | null;
  value_seen: string | null;
}

export interface DraftRow {
  id: number;
  application_id: number;
  kind: "cover_letter" | "answer";
  question_key: string | null;
  question_text: string | null;
  text: string;
  cited_fact_ids: string[];
  checker_status: "pass" | "flagged";
  checker_notes: string[];
  edited_by_user: boolean;
}

const json = (v: unknown) => JSON.stringify(v);
function parse<T>(v: unknown, fallback: T): T {
  return typeof v === "string" ? (JSON.parse(v) as T) : fallback;
}

export class Store {
  readonly db: DatabaseSync;
  private readonly clock: () => string;

  constructor(path: string, clock: () => string = () => new Date().toISOString()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.clock = clock;
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  now(): string {
    return this.clock();
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    for (let v = row.user_version; v < MIGRATIONS.length; v++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- meta ----
  getMeta(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      { value: string } | undefined;
    return r?.value ?? null;
  }
  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  // ---- postings ----
  savePostings(postings: Posting[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO postings (id, company, company_norm, title, role_family, ats, apply_url, is_open, first_seen, last_seen, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET company = excluded.company, company_norm = excluded.company_norm,
        title = excluded.title, role_family = excluded.role_family, ats = excluded.ats,
        apply_url = excluded.apply_url, is_open = excluded.is_open, first_seen = excluded.first_seen,
        last_seen = excluded.last_seen, data = excluded.data`);
    this.transaction(() => {
      for (const p of postings) {
        stmt.run(
          p.id,
          p.company,
          normalizeCompany(p.company),
          p.title,
          p.roleFamily,
          p.ats,
          p.applyUrl,
          p.isOpen ? 1 : 0,
          p.firstSeen,
          p.lastSeen,
          json(p),
        );
      }
    });
  }

  allPostings(): Posting[] {
    return (this.db.prepare("SELECT data FROM postings").all() as { data: string }[]).map(
      (r) => JSON.parse(r.data) as Posting,
    );
  }

  getPosting(id: string): Posting | null {
    const r = this.db.prepare("SELECT data FROM postings WHERE id = ?").get(id) as
      { data: string } | undefined;
    return r ? (JSON.parse(r.data) as Posting) : null;
  }

  setQuestions(id: string, questions: FormQuestion[]): void {
    const p = this.getPosting(id);
    if (!p) throw new Error(`No posting ${id}`);
    this.savePostings([{ ...p, questions }]);
  }

  // ---- open-posting checks ----
  /**
   * Record whether a posting is still open. An expired verdict also closes the posting, and
   * sourcing keeps it closed even if a list still shows it, so it never comes back.
   */
  recordLiveness(
    postingId: string,
    r: { verdict: LivenessRow["verdict"]; code: string; reason: string; via: string },
  ): void {
    this.db
      .prepare(
        `INSERT INTO liveness_checks (posting_id, verdict, code, reason, via, checked_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(posting_id) DO UPDATE SET verdict = excluded.verdict, code = excluded.code,
          reason = excluded.reason, via = excluded.via, checked_at = excluded.checked_at`,
      )
      .run(postingId, r.verdict, r.code, r.reason, r.via, this.now());
    if (r.verdict === "expired") {
      const p = this.getPosting(postingId);
      if (p?.isOpen) this.savePostings([{ ...p, isOpen: false }]);
    }
  }

  getLiveness(postingId: string): LivenessRow | null {
    return (
      (this.db.prepare("SELECT * FROM liveness_checks WHERE posting_id = ?").get(postingId) as
        LivenessRow | undefined) ?? null
    );
  }

  expiredPostingIds(): Set<string> {
    const rows = this.db
      .prepare("SELECT posting_id FROM liveness_checks WHERE verdict = 'expired'")
      .all() as { posting_id: string }[];
    return new Set(rows.map((r) => r.posting_id));
  }

  // ---- scores ----
  saveScore(
    postingId: string,
    passed: boolean,
    reasons: string[],
    fit: FitScore | null,
    inputHash: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO fit_scores (posting_id, passed, filter_reasons, score, tier, components, match, input_hash, scored_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(posting_id) DO UPDATE SET passed = excluded.passed, filter_reasons = excluded.filter_reasons,
          score = excluded.score, tier = excluded.tier, components = excluded.components, match = excluded.match,
          input_hash = excluded.input_hash, scored_at = excluded.scored_at`,
      )
      .run(
        postingId,
        passed ? 1 : 0,
        json(reasons),
        fit?.score ?? null,
        fit?.tier ?? null,
        fit ? json(fit.components) : null,
        fit ? json(fit.match) : null,
        inputHash,
        this.now(),
      );
  }

  getScore(postingId: string): ScoreRow | null {
    const r = this.db.prepare("SELECT * FROM fit_scores WHERE posting_id = ?").get(postingId) as
      Row | undefined;
    return r ? this.toScore(r) : null;
  }

  private toScore(r: Row): ScoreRow {
    const fit: FitScore | null =
      r.score == null
        ? null
        : {
            score: Number(r.score),
            tier: r.tier as Tier,
            components: parse(r.components, {} as FitScore["components"]),
            match: parse(r.match, { required: [], matched: [], missing: [], method: "keywords" }),
          };
    return {
      posting_id: String(r.posting_id),
      passed: Number(r.passed) === 1,
      filter_reasons: parse(r.filter_reasons, []),
      fit,
      input_hash: String(r.input_hash),
      scored_at: String(r.scored_at),
    };
  }

  /** Open postings that passed the filters, best score first. */
  rankedCandidates(limit = 1000): { posting: Posting; score: ScoreRow }[] {
    const rows = this.db
      .prepare(
        `SELECT p.data, s.* FROM postings p JOIN fit_scores s ON s.posting_id = p.id
        WHERE p.is_open = 1 AND s.passed = 1 ORDER BY s.score DESC LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map((r) => ({
      posting: JSON.parse(String(r.data)) as Posting,
      score: this.toScore(r),
    }));
  }

  openPostings(): Posting[] {
    return (
      this.db.prepare("SELECT data FROM postings WHERE is_open = 1").all() as { data: string }[]
    ).map((r) => JSON.parse(r.data) as Posting);
  }

  // ---- applications ----
  createApplication(postingId: string, tier: Tier): ApplicationRow {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO applications (posting_id, tier, status, created_at, updated_at) VALUES (?, ?, 'prepared', ?, ?)
        ON CONFLICT(posting_id) DO NOTHING`,
      )
      .run(postingId, tier, now, now);
    const app = this.applicationForPosting(postingId)!;
    this.logEvent(app.id, "created", { tier });
    return app;
  }

  applicationForPosting(postingId: string): ApplicationRow | null {
    return (
      (this.db.prepare("SELECT * FROM applications WHERE posting_id = ?").get(postingId) as
        ApplicationRow | undefined) ?? null
    );
  }

  getApplication(id: number): ApplicationRow | null {
    return (
      (this.db.prepare("SELECT * FROM applications WHERE id = ?").get(id) as
        ApplicationRow | undefined) ?? null
    );
  }

  listApplications(filter: { status?: ApplicationStatus[]; tier?: Tier } = {}): ApplicationRow[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.status?.length) {
      where.push(`status IN (${filter.status.map(() => "?").join(",")})`);
      args.push(...filter.status);
    }
    if (filter.tier) {
      where.push("tier = ?");
      args.push(filter.tier);
    }
    const sql = `SELECT * FROM applications ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id`;
    return this.db.prepare(sql).all(...args) as unknown as ApplicationRow[];
  }

  /** Move an application along the status machine. Illegal moves throw. */
  setStatus(
    id: number,
    to: ApplicationStatus,
    extra: Partial<Pick<ApplicationRow, "snapshot_path">> = {},
  ): ApplicationRow {
    const app = this.getApplication(id);
    if (!app) throw new Error(`No application ${id}`);
    if (app.status === to) return app;
    assertTransition(app.status, to);
    const now = this.now();
    const stamps: Record<string, string> = {};
    if (to === "approved") stamps.approved_at = now;
    if (to === "filled") stamps.filled_at = now;
    if (to === "submitted") stamps.submitted_at = now;
    const sets = ["status = ?", "updated_at = ?", ...Object.keys(stamps).map((k) => `${k} = ?`)];
    const vals: (string | number)[] = [to, now, ...Object.values(stamps)];
    if (extra.snapshot_path) {
      sets.push("snapshot_path = ?");
      vals.push(extra.snapshot_path);
    }
    this.db.prepare(`UPDATE applications SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    this.logEvent(id, "status", { from: app.status, to });
    return this.getApplication(id)!;
  }

  updateTracking(
    id: number,
    fields: Partial<Pick<ApplicationRow, "next_action" | "next_action_due" | "contact" | "notes">>,
  ): void {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    this.db
      .prepare(
        `UPDATE applications SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
      )
      .run(...keys.map((k) => fields[k] ?? null), this.now(), id);
  }

  countActiveForCompany(companyNorm: string): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM applications a JOIN postings p ON p.id = a.posting_id
        WHERE p.company_norm = ? AND a.status NOT IN ('skipped', 'parked')`,
      )
      .get(companyNorm) as { n: number };
    return r.n;
  }

  // ---- resume variants, drafts, fills ----
  saveResumeVariant(
    applicationId: number,
    plan: unknown,
    pdfPath: string | null,
    diff: unknown,
    parseCheck: unknown,
  ): number {
    const r = this.db
      .prepare(
        "INSERT INTO resume_variants (application_id, plan, pdf_path, diff, parse_check, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(applicationId, json(plan), pdfPath, json(diff), json(parseCheck), this.now());
    const id = Number(r.lastInsertRowid);
    this.db
      .prepare("UPDATE applications SET resume_variant_id = ?, updated_at = ? WHERE id = ?")
      .run(id, this.now(), applicationId);
    return id;
  }

  getResumeVariant(id: number): {
    id: number;
    plan: unknown;
    pdf_path: string | null;
    diff: unknown;
    parse_check: unknown;
  } | null {
    const r = this.db.prepare("SELECT * FROM resume_variants WHERE id = ?").get(id) as
      Row | undefined;
    if (!r) return null;
    return {
      id: Number(r.id),
      plan: parse(r.plan, null),
      pdf_path: (r.pdf_path as string | null) ?? null,
      diff: parse(r.diff, null),
      parse_check: parse(r.parse_check, null),
    };
  }

  replaceDrafts(
    applicationId: number,
    drafts: Omit<DraftRow, "id" | "application_id" | "edited_by_user">[],
  ): void {
    const now = this.now();
    this.transaction(() => {
      this.db
        .prepare("DELETE FROM drafts WHERE application_id = ? AND edited_by_user = 0")
        .run(applicationId);
      const stmt = this.db
        .prepare(`INSERT INTO drafts (application_id, kind, question_key, question_text, text, cited_fact_ids, checker_status, checker_notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const d of drafts) {
        stmt.run(
          applicationId,
          d.kind,
          d.question_key,
          d.question_text,
          d.text,
          json(d.cited_fact_ids),
          d.checker_status,
          json(d.checker_notes),
          now,
          now,
        );
      }
    });
  }

  listDrafts(applicationId: number): DraftRow[] {
    return (
      this.db
        .prepare("SELECT * FROM drafts WHERE application_id = ? ORDER BY id")
        .all(applicationId) as Row[]
    ).map((r) => ({
      id: Number(r.id),
      application_id: Number(r.application_id),
      kind: r.kind as DraftRow["kind"],
      question_key: (r.question_key as string | null) ?? null,
      question_text: (r.question_text as string | null) ?? null,
      text: String(r.text),
      cited_fact_ids: parse(r.cited_fact_ids, []),
      checker_status: r.checker_status as DraftRow["checker_status"],
      checker_notes: parse(r.checker_notes, []),
      edited_by_user: Number(r.edited_by_user) === 1,
    }));
  }

  editDraft(draftId: number, text: string): void {
    this.db
      .prepare(
        "UPDATE drafts SET text = ?, edited_by_user = 1, checker_status = 'pass', checker_notes = '[]', updated_at = ? WHERE id = ?",
      )
      .run(text, this.now(), draftId);
  }

  replaceFieldFills(applicationId: number, fills: FillEntry[]): void {
    const now = this.now();
    this.transaction(() => {
      this.db
        .prepare("DELETE FROM field_fills WHERE application_id = ? AND source != 'you'")
        .run(applicationId);
      const stmt = this.db
        .prepare(`INSERT INTO field_fills (application_id, field_key, label, field_type,
          planned_value, source, confidence, flag, note, required, options, attach, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(application_id, field_key) DO NOTHING`);
      for (const f of fills) {
        stmt.run(
          applicationId,
          f.key,
          f.label,
          f.type,
          f.value,
          f.source,
          f.confidence,
          f.flag,
          f.note,
          f.required ? 1 : 0,
          f.options ? json(f.options) : null,
          f.attach ?? null,
          now,
        );
      }
    });
  }

  listFieldFills(applicationId: number): FieldFillRow[] {
    return (
      this.db
        .prepare("SELECT * FROM field_fills WHERE application_id = ? ORDER BY id")
        .all(applicationId) as Row[]
    ).map((r) => ({
      application_id: Number(r.application_id),
      field_key: String(r.field_key),
      label: String(r.label),
      field_type: r.field_type as FormQuestion["type"],
      planned_value: (r.planned_value as string | null) ?? null,
      source: r.source as FillSource,
      confidence: r.confidence as Confidence,
      flag: (r.flag as Flag) ?? null,
      note: (r.note as string | null) ?? null,
      required: Number(r.required) === 1,
      options: parse(r.options, null),
      attach: (r.attach as FieldFillRow["attach"]) ?? null,
      value_seen: (r.value_seen as string | null) ?? null,
    }));
  }

  /** Your own value for a field. It is never overwritten by a later re-prep. */
  setFieldByUser(applicationId: number, fieldKey: string, value: string): void {
    this.db
      .prepare(
        "UPDATE field_fills SET planned_value = ?, source = 'you', confidence = 'high', flag = NULL, note = NULL, updated_at = ? WHERE application_id = ? AND field_key = ?",
      )
      .run(value, this.now(), applicationId, fieldKey);
  }

  recordValuesSeen(applicationId: number, seen: Record<string, string | null>): void {
    const stmt = this.db.prepare(
      "UPDATE field_fills SET value_seen = ?, updated_at = ? WHERE application_id = ? AND field_key = ?",
    );
    this.transaction(() => {
      for (const [k, v] of Object.entries(seen)) stmt.run(v, this.now(), applicationId, k);
    });
  }

  // ---- learned answers ----
  saveLearnedAnswer(
    questionKey: string,
    questionText: string,
    answer: string,
    fromApplicationId: number | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO learned_answers (question_key, question_text, answer, from_application_id, created_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(question_key) DO UPDATE SET answer = excluded.answer, question_text = excluded.question_text`,
      )
      .run(questionKey, questionText, answer, fromApplicationId, this.now());
  }

  learnedAnswers(): Map<string, { question: string; answer: string }> {
    const rows = this.db
      .prepare("SELECT question_key, question_text, answer FROM learned_answers")
      .all() as { question_key: string; question_text: string; answer: string }[];
    return new Map(
      rows.map((r) => [r.question_key, { question: r.question_text, answer: r.answer }]),
    );
  }

  // ---- events, cost, polls ----
  logEvent(applicationId: number | null, type: string, payload: unknown = {}): void {
    this.db
      .prepare("INSERT INTO events (application_id, at, type, payload) VALUES (?, ?, ?, ?)")
      .run(applicationId, this.now(), type, json(payload));
  }

  events(applicationId: number): { at: string; type: string; payload: unknown }[] {
    return (
      this.db
        .prepare("SELECT at, type, payload FROM events WHERE application_id = ? ORDER BY id")
        .all(applicationId) as Row[]
    ).map((r) => ({
      at: String(r.at),
      type: String(r.type),
      payload: parse(r.payload, {}),
    }));
  }

  logLlmCall(purpose: string, model: string, usage: TokenUsage, batch = false): void {
    this.db
      .prepare(
        "INSERT INTO llm_calls (purpose, model, input_tokens, cached_tokens, cache_write_tokens, output_tokens, cost_usd, batch, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        purpose,
        model,
        usage.input_tokens,
        usage.cache_read_input_tokens ?? 0,
        usage.cache_creation_input_tokens ?? 0,
        usage.output_tokens,
        costUsd(model, usage, { batch }),
        batch ? 1 : 0,
        this.now(),
      );
  }

  costSummary(): { purpose: string; calls: number; usd: number }[] {
    return this.db
      .prepare(
        "SELECT purpose, COUNT(*) AS calls, ROUND(SUM(cost_usd), 4) AS usd FROM llm_calls GROUP BY purpose ORDER BY usd DESC",
      )
      .all() as unknown as {
      purpose: string;
      calls: number;
      usd: number;
    }[];
  }

  logPoll(source: string, ok: boolean, error: string | null, count: number): void {
    this.db
      .prepare("INSERT INTO poll_runs (at, source, ok, error, count) VALUES (?, ?, ?, ?, ?)")
      .run(this.now(), source, ok ? 1 : 0, error, count);
  }

  // ---- batches ----
  saveBatch(id: string, purpose: string, applicationIds: number[]): void {
    this.db
      .prepare(
        "INSERT INTO batches (id, purpose, status, application_ids, created_at) VALUES (?, ?, 'in_progress', ?, ?)",
      )
      .run(id, purpose, json(applicationIds), this.now());
  }

  openBatches(): { id: string; purpose: string; application_ids: number[] }[] {
    return (
      this.db
        .prepare("SELECT id, purpose, application_ids FROM batches WHERE collected_at IS NULL")
        .all() as Row[]
    ).map((r) => ({
      id: String(r.id),
      purpose: String(r.purpose),
      application_ids: parse(r.application_ids, []),
    }));
  }

  markBatchCollected(id: string): void {
    this.db
      .prepare("UPDATE batches SET status = 'ended', collected_at = ? WHERE id = ?")
      .run(this.now(), id);
  }
}
