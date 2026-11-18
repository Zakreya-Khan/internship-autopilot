// The learned-answer bank: match questions to answers you gave, the questions inbox, and backfill.
import type { FormQuestion, LearnedAnswer, LearnedHit } from "@ia/core";
import {
  AUTO_MATCH,
  defaultScope,
  findLearnedAnswer,
  isCompanySpecific,
  isSensitiveQuestion,
  normalizeCompany,
  pickOption,
  questionKey,
  questionSimilarity,
  sameCompany,
} from "@ia/core";
import type { LlmClient } from "@ia/ai";
import { sameQuestion } from "@ia/ai";
import type { ApplicationStatus } from "@ia/core";
import type { FieldFillRow, Store } from "./db.ts";

export type Scope = "always" | "company" | "once";

/** Applications whose fields can still change. Submitted ones are never touched. */
const PENDING: ApplicationStatus[] = ["needs_input", "ready", "approved"];
/** Applications that backfill fills: approved ones were already checked by you. */
const BACKFILL: ApplicationStatus[] = ["needs_input", "ready"];

/** Your answer, put onto this form's options. Null when it doesn't map onto any of them. */
export function mapOntoOptions(
  answer: string,
  options: string[] | null | undefined,
): string | null {
  if (!options?.length) return answer;
  const exact = options.find((o) => o.trim().toLowerCase() === answer.trim().toLowerCase());
  return exact ?? pickOption(options, answer);
}

/**
 * Look one question up: exact wording or a confirmed alias fills it; a very close match fills it
 * if your answer maps onto the form's options; anything looser is a suggestion. Borderline
 * matches are first checked with the model when one is available (only the two question texts
 * are sent), and the verdict is cached.
 */
export async function resolveQuestion(
  store: Store,
  q: Pick<FormQuestion, "key" | "label" | "type" | "options">,
  company: string,
  llm: LlmClient | null,
  bank: LearnedAnswer[] = store.learnedBank(),
): Promise<LearnedHit | null> {
  const cand = findLearnedAnswer(q, company, bank, store.rejectedFor(questionKey(q.label)));
  if (!cand) return null;
  const mapped = mapOntoOptions(cand.answer.answer, q.options);
  const confident = cand.how === "exact" || cand.score >= AUTO_MATCH;
  if (confident && mapped !== null)
    return { kind: "fill", value: mapped, answerId: cand.answer.id };
  if (!confident) {
    const a = questionKey(q.label);
    const b = cand.answer.questionKey;
    let same = store.pairVerdict(a, b);
    if (same === null && llm) {
      try {
        same = await sameQuestion(llm, q.label, cand.answer.question);
        store.savePairVerdict(a, b, same);
      } catch {
        same = null; // no verdict: still offered, as a suggestion you confirm
      }
    }
    if (same === false) return null;
  }
  return {
    kind: "suggest",
    value: mapped ?? cand.answer.answer,
    answerId: cand.answer.id,
    from: cand.answer.question,
    score: Math.round(cand.score * 100) / 100,
    mapped: mapped !== null,
  };
}

/** Every question of a form, looked up. Keyed by the question's form key. */
export async function resolveQuestions(
  store: Store,
  questions: FormQuestion[],
  company: string,
  llm: LlmClient | null,
): Promise<Map<string, LearnedHit>> {
  const bank = store.learnedBank();
  const out = new Map<string, LearnedHit>();
  if (!bank.length) return out;
  for (const q of questions) {
    const hit = await resolveQuestion(store, q, company, llm, bank);
    if (hit) out.set(q.key, hit);
  }
  return out;
}

/** Without any model call: the questions the bank fills outright (so they aren't drafted). */
export function filledFromBank(
  store: Store,
  questions: FormQuestion[],
  company: string,
): Set<string> {
  const bank = store.learnedBank();
  const out = new Set<string>();
  for (const q of questions) {
    const c = findLearnedAnswer(q, company, bank, store.rejectedFor(questionKey(q.label)));
    if (
      c &&
      (c.how === "exact" || c.score >= AUTO_MATCH) &&
      mapOntoOptions(c.answer.answer, q.options) !== null
    )
      out.add(q.key);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The questions inbox

/** A field the tool couldn't fill, on an application that isn't submitted. */
export function unanswered(f: FieldFillRow): boolean {
  return (
    (f.flag === "red" || f.flag === "amber") &&
    (f.planned_value === null || f.planned_value === "") &&
    f.field_type !== "file" &&
    f.attach === null
  );
}

export interface InboxItem {
  applicationId: number;
  company: string;
  title: string;
  status: ApplicationStatus;
  fieldKey: string;
  label: string;
  type: FormQuestion["type"];
  options: string[] | null;
  required: boolean;
  note: string | null;
  suggestion: FieldFillRow["suggestion"];
}

export interface InboxGroup {
  /** Stable id for this group in this listing. */
  id: string;
  question: string;
  /** Other wordings grouped with it. */
  wordings: string[];
  type: FormQuestion["type"];
  options: string[] | null;
  required: boolean;
  /** About you and one employer: answers are reused only at that company. */
  companySpecific: boolean;
  /** EEO, work authorization, GPA or contact details: answered for these applications only. */
  sensitive: boolean;
  defaultScope: Scope;
  companies: string[];
  items: InboxItem[];
}

/** Every unanswered question across pending applications, one group per question. */
export function questionsInbox(
  store: Store,
  opts: { includeOptional?: boolean } = {},
): InboxGroup[] {
  const items: InboxItem[] = [];
  for (const a of store.listApplications({ status: PENDING })) {
    const p = store.getPosting(a.posting_id);
    if (!p) continue;
    for (const f of store.listFieldFills(a.id)) {
      if (!unanswered(f)) continue;
      if (!opts.includeOptional && !f.required && f.flag !== "red") continue;
      items.push({
        applicationId: a.id,
        company: p.company,
        title: p.title,
        status: a.status,
        fieldKey: f.field_key,
        label: f.label,
        type: f.field_type,
        options: f.options,
        required: f.required || f.flag === "red",
        note: f.note,
        suggestion: f.suggestion,
      });
    }
  }
  const groups: InboxGroup[] = [];
  for (const it of items) {
    const specific = isCompanySpecific(it.label, it.company);
    const sensitive = isSensitiveQuestion({ key: it.fieldKey, label: it.label, type: it.type });
    // Same wording, or wording close enough to fill automatically (and the same company when the
    // question is about the company). Sensitive questions group by exact wording only.
    const g = groups.find(
      (g) =>
        g.sensitive === sensitive &&
        g.companySpecific === specific &&
        (!specific || sameCompany(g.companies[0]!, it.company)) &&
        (questionKey(g.question) === questionKey(it.label) ||
          (!sensitive &&
            questionSimilarity(g.question, it.label, g.companies[0], it.company) >= AUTO_MATCH)),
    );
    if (g) {
      g.items.push(it);
      g.required ||= it.required;
      if (!g.companies.includes(it.company)) g.companies.push(it.company);
      if (it.label !== g.question && !g.wordings.includes(it.label)) g.wordings.push(it.label);
      continue;
    }
    groups.push({
      id: `${questionKey(it.label)}${specific ? `@${normalizeCompany(it.company)}` : ""}`,
      question: it.label,
      wordings: [],
      type: it.type,
      options: it.options,
      required: it.required,
      companySpecific: specific,
      sensitive,
      defaultScope: sensitive ? "once" : defaultScope(it.label, it.company),
      companies: [it.company],
      items: [it],
    });
  }
  // Most applications first, then required before optional.
  return groups.sort(
    (a, b) => Number(b.required) - Number(a.required) || b.items.length - a.items.length,
  );
}

// ---------------------------------------------------------------------------------------------
// Answering, backfill, suggestions

export interface AnswerResult {
  /** Fields filled with your answer. */
  filled: number;
  /** Fields your answer didn't map onto (their options differ): left as suggestions. */
  unmapped: { applicationId: number; fieldKey: string }[];
  /** Learned answers saved (none for "just this once" or sensitive questions). */
  saved: number[];
  /** Scope actually used: company-specific questions can't be reused across companies. */
  scope: Scope;
  /** Other pending applications filled or offered a suggestion by the new answer. */
  backfill: BackfillResult;
  /** Applications that moved between Needs input and Ready. */
  touched: number[];
}

/**
 * You answered a question (once, for every application in `items`). Each field gets your answer,
 * mapped onto its own options; the answer is saved to the bank by scope; then every other
 * pending application is checked for the same or a similar question.
 */
export async function answerQuestion(
  store: Store,
  llm: LlmClient | null,
  items: { applicationId: number; fieldKey: string }[],
  answer: string,
  requested: Scope,
): Promise<AnswerResult> {
  const value = answer.trim();
  if (!value) throw new Error("no answer given");
  const fields = items.map((it) => {
    const a = store.getApplication(it.applicationId);
    if (!a) throw new Error(`no application ${it.applicationId}`);
    if (!PENDING.includes(a.status))
      throw new Error(`application ${a.id} is ${a.status}; its fields are locked`);
    const f = store.listFieldFills(a.id).find((x) => x.field_key === it.fieldKey);
    if (!f) throw new Error(`no field ${it.fieldKey} on application ${a.id}`);
    const company = store.getPosting(a.posting_id)?.company ?? "";
    return { app: a, field: f, company };
  });
  if (!fields.length) throw new Error("nothing to answer");

  const sensitive = fields.some((x) =>
    isSensitiveQuestion({ key: x.field.field_key, label: x.field.label, type: x.field.field_type }),
  );
  const specific = fields.some((x) => isCompanySpecific(x.field.label, x.company));
  // Sensitive answers are for these applications only; questions about one employer are never
  // reused at another, whatever you picked.
  const scope: Scope = sensitive
    ? "once"
    : specific && requested === "always"
      ? "company"
      : requested;

  // Save first, so each field can record which answer filled it.
  const saved = new Map<string, number>(); // company ("" for always) -> answer id
  if (scope !== "once") {
    const first = fields[0]!;
    for (const x of fields) {
      const c = scope === "company" ? x.company : "";
      if (saved.has(normalizeCompany(c))) continue;
      const id = store.saveLearnedAnswer({
        questionKey: questionKey(first.field.label),
        question: first.field.label,
        answer: value,
        scope,
        company: c,
        fieldType: first.field.field_type,
        options: first.field.options,
        fromApplicationId: first.app.id,
      });
      saved.set(normalizeCompany(c), id);
    }
    // Every wording you answered together is the same question from now on.
    for (const x of fields) {
      const id = saved.get(normalizeCompany(scope === "company" ? x.company : ""))!;
      if (questionKey(x.field.label) !== store.getLearned(id)?.questionKey)
        store.addAlias(id, questionKey(x.field.label), x.field.label);
    }
  }

  const unmapped: AnswerResult["unmapped"] = [];
  let filled = 0;
  for (const x of fields) {
    const answerId = saved.get(normalizeCompany(scope === "company" ? x.company : "")) ?? null;
    const v = mapOntoOptions(value, x.field.options);
    if (v === null) {
      unmapped.push({ applicationId: x.app.id, fieldKey: x.field.field_key });
      if (answerId)
        store.setSuggestion(x.app.id, x.field.field_key, {
          answerId,
          value,
          from: x.field.label,
          score: 1,
          mapped: false,
        });
      continue;
    }
    store.setFieldByUser(x.app.id, x.field.field_key, v, answerId);
    if (x.app.status === "approved") store.setStatus(x.app.id, "ready");
    filled++;
  }
  // Log that it happened, never what you answered.
  for (const x of fields)
    store.logEvent(x.app.id, "question_answered", { key: x.field.field_key, scope });

  const backfill = saved.size ? await backfillPending(store, llm) : emptyBackfill();
  const touched = refreshAll(store, [...fields.map((x) => x.app.id), ...backfill.applications]);
  return { filled, unmapped, saved: [...saved.values()], scope, backfill, touched };
}

export interface BackfillResult {
  filled: number;
  suggested: number;
  applications: number[];
}
const emptyBackfill = (): BackfillResult => ({ filled: 0, suggested: 0, applications: [] });

/**
 * Check every unanswered field on pending applications against the bank: the same question (or
 * a very close one that maps) is filled, a similar one gets a suggestion.
 */
export async function backfillPending(
  store: Store,
  llm: LlmClient | null,
): Promise<BackfillResult> {
  const bank = store.learnedBank();
  const r = emptyBackfill();
  if (!bank.length) return r;
  for (const a of store.listApplications({ status: BACKFILL })) {
    const company = store.getPosting(a.posting_id)?.company ?? "";
    let changed = false;
    for (const f of store.listFieldFills(a.id)) {
      if (!unanswered(f)) continue;
      const hit = await resolveQuestion(
        store,
        { key: f.field_key, label: f.label, type: f.field_type, options: f.options ?? undefined },
        company,
        llm,
        bank,
      );
      if (!hit) continue;
      if (hit.kind === "fill") {
        store.setFieldByUser(a.id, f.field_key, hit.value, hit.answerId);
        r.filled++;
        changed = true;
      } else if (f.suggestion?.answerId !== hit.answerId) {
        store.setSuggestion(a.id, f.field_key, {
          answerId: hit.answerId,
          value: hit.value,
          from: hit.from,
          score: hit.score,
          mapped: hit.mapped,
        });
        r.suggested++;
        changed = true;
      }
    }
    if (changed) r.applications.push(a.id);
  }
  return r;
}

/**
 * Accept or reject a suggestion. Accepting fills the field (with `value` if you picked a
 * different option) and remembers the wording as an alias; rejecting remembers that this answer
 * doesn't fit this question.
 */
export async function settleSuggestion(
  store: Store,
  llm: LlmClient | null,
  applicationId: number,
  fieldKey: string,
  accept: boolean,
  value?: string,
): Promise<{ touched: number[]; backfill: BackfillResult }> {
  const a = store.getApplication(applicationId);
  if (!a || !PENDING.includes(a.status)) throw new Error("that application can't be changed");
  const f = store.listFieldFills(a.id).find((x) => x.field_key === fieldKey);
  if (!f?.suggestion) throw new Error("no suggestion on that field");
  const s = f.suggestion;
  const learned = store.getLearned(s.answerId);
  if (!accept) {
    store.rejectMatch(s.answerId, questionKey(f.label));
    store.setSuggestion(a.id, fieldKey, null);
    return { touched: refreshAll(store, [a.id]), backfill: emptyBackfill() };
  }
  const v = value?.trim() || (s.mapped ? s.value : null);
  if (!v) throw new Error("pick one of this form's options for your answer");
  if (f.options?.length && !f.options.includes(v))
    throw new Error("that isn't one of this form's options");
  store.setFieldByUser(a.id, fieldKey, v, learned ? s.answerId : null);
  if (learned && questionKey(f.label) !== learned.questionKey)
    store.addAlias(s.answerId, questionKey(f.label), f.label);
  if (a.status === "approved") store.setStatus(a.id, "ready");
  const backfill = await backfillPending(store, llm);
  return { touched: refreshAll(store, [a.id, ...backfill.applications]), backfill };
}

/** Put an edited answer into the pending applications that used it. Submitted ones are never changed. */
export function applyAnswerToPending(
  store: Store,
  answerId: number,
): { updated: number; skipped: number; touched: number[] } {
  const learned = store.getLearned(answerId);
  if (!learned) throw new Error(`no learned answer ${answerId}`);
  let updated = 0;
  let skipped = 0;
  const apps = new Set<number>();
  for (const f of store.pendingFieldsUsing(answerId)) {
    const v = mapOntoOptions(learned.answer, f.options);
    if (v === null) {
      skipped++;
      continue;
    }
    store.setFieldByUser(f.application_id, f.field_key, v, answerId);
    if (f.status === "approved") store.setStatus(f.application_id, "ready");
    apps.add(f.application_id);
    updated++;
  }
  return { updated, skipped, touched: refreshAll(store, [...apps]) };
}

/** Needs input ⇄ Ready for each application, as its fields now stand. Returns those that moved. */
export function refreshAll(store: Store, ids: number[]): number[] {
  const moved: number[] = [];
  for (const id of new Set(ids)) if (refreshReadiness(store, id)) moved.push(id);
  return moved;
}

/** Needs input → Ready once nothing blocks; Ready → Needs input if something new does. */
export function refreshReadiness(store: Store, id: number): boolean {
  const a = store.getApplication(id);
  if (!a || (a.status !== "needs_input" && a.status !== "ready")) return false;
  const variant = a.resume_variant_id ? store.getResumeVariant(a.resume_variant_id) : null;
  const parseOk = (variant?.parse_check as { ok?: boolean } | null)?.ok !== false;
  const draftsOk = store.listDrafts(id).every((d) => d.checker_status === "pass");
  const ok = !store.listFieldFills(id).some((f) => f.flag === "red") && parseOk && draftsOk;
  const want = ok ? "ready" : "needs_input";
  if (a.status === want) return false;
  store.setStatus(id, want);
  return true;
}
