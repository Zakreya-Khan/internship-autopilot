import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ClaimToCheck,
  DraftedAnswer,
  FormQuestion,
  Posting,
  ResumeDoc,
  Tier,
  TruthIssue,
  VoiceTraits,
  WritingIssue,
} from "@ia/core";
import {
  applyResumePlan,
  buildBaseResume,
  buildFillPlan,
  checkClaims,
  checkWriting,
  classifyQuestion,
  diffResume,
  hasBlockingFlags,
  indexFacts,
  normalizeCompany,
  profileOwnWords,
  questionKey,
  STANDARD_QUESTIONS,
  voiceNotes,
} from "@ia/core";
import type { Draft, DraftRequest } from "@ia/ai";
import { draftApplication, modelTruthCheck } from "@ia/ai";
import { parseCheckResume, renderCoverLetterPdf, renderResumePdf } from "@ia/render";
import type { ApplicationRow, Store } from "./db.ts";
import type { LivenessCheck } from "./liveness.ts";
import { ensureOpen, PREP_RECHECK_MS } from "./liveness.ts";
import type { PipelineDeps } from "./pipeline.ts";

export interface PrepDeps extends PipelineDeps {
  outDir: string;
  /** Checks a posting is still open before any tokens are spent on it. Null: no check. */
  liveness?: LivenessCheck | null;
  /** Numbers measured from your writing samples (profile style.writing_samples). */
  voice?: VoiceTraits | null;
  /** Drafting model for Tier B, if the user opted into Sonnet. Tier A always uses Opus. */
  tierBModel?: DraftRequest["model"];
}

/** Everything known before the model is asked. Shared by live prep and the Batch API path. */
export interface PrepInputs {
  app: ApplicationRow;
  posting: Posting;
  tier: Tier;
  questions: FormQuestion[];
  openToDraft: FormQuestion[];
  coverLetter: boolean;
}

export function questionsFor(posting: Posting): FormQuestion[] {
  if (posting.questions?.length) return posting.questions;
  if (posting.ats === "lever" || posting.ats === "ashby") return STANDARD_QUESTIONS[posting.ats];
  return STANDARD_QUESTIONS.default;
}

export function prepInputs(deps: PrepDeps, posting: Posting, tier: Tier): PrepInputs {
  const { store } = deps;
  const app = store.applicationForPosting(posting.id) ?? store.createApplication(posting.id, tier);
  const questions = questionsFor(posting);
  const learned = store.learnedAnswers();
  const openToDraft = questions.filter(
    (q) => classifyQuestion(q).kind === "open" && !learned.has(questionKey(q.label)),
  );
  const coverField = questions.find((q) => {
    const c = classifyQuestion(q);
    return c.kind === "known" && c.field === "cover_letter";
  });
  const coverLetter = Boolean(coverField && (coverField.required || tier === "A"));
  return { app, posting, tier, questions, openToDraft, coverLetter };
}

export function draftRequest(deps: PrepDeps, i: PrepInputs): DraftRequest {
  return {
    profile: deps.profile,
    posting: i.posting,
    tier: i.tier,
    openQuestions: i.openToDraft,
    coverLetter: i.coverLetter,
    voice: deps.voice ?? null,
    ...(i.tier === "B" && deps.tierBModel ? { model: deps.tierBModel } : {}),
  };
}

/** Every generated text in a draft, labelled the same way the truth check labels it. */
export function draftTexts(draft: Draft): { where: string; text: string }[] {
  return [
    ...draft.resumePlan.entries.flatMap((e) =>
      e.bullets.map((b, n) => ({ where: `bullet:${e.entryId}:${n}`, text: b.text })),
    ),
    ...draft.answers.map((a) => ({ where: `answer:${a.questionKey}`, text: a.text })),
    ...(draft.coverLetter ?? []).map((p, n) => ({ where: `cover:${n}`, text: p.text })),
  ];
}

export function writingIssuesFor(deps: PrepDeps, draft: Draft): WritingIssue[] {
  return checkWriting(draftTexts(draft), profileOwnWords(deps.profile));
}

/** No model available: the base resume, untouched, and every open question left for you. */
export function offlineDraft(deps: PrepDeps): Draft {
  const base = buildBaseResume(deps.profile);
  return {
    resumePlan: {
      entries: [...base.experience, ...base.projects].map((e) => ({
        entryId: e.id,
        bullets: e.bullets,
      })),
      skillsOrder: base.skills,
      courses: base.education[0]?.courses ?? [],
    },
    answers: [],
    coverLetter: null,
    fitNote: { why: "Prepared offline: resume not tailored.", gaps: "" },
  };
}

/** Replace any blocked resume bullet with the original wording of the facts it cites. */
function revertBlockedBullets(doc: ResumeDoc, blocked: Set<string>, deps: PrepDeps): ResumeDoc {
  const facts = indexFacts(deps.profile);
  const fix = (entries: ResumeDoc["experience"]) =>
    entries.map((e) => ({
      ...e,
      bullets: e.bullets.map((b, i) =>
        blocked.has(`bullet:${e.id}:${i}`)
          ? {
              text: b.factIds.map((id) => facts.get(id)?.text ?? "").join("; "),
              factIds: b.factIds,
            }
          : b,
      ),
    }));
  return { ...doc, experience: fix(doc.experience), projects: fix(doc.projects) };
}

export interface PrepOutcome {
  applicationId: number;
  status: "ready" | "needs_input";
  issues: TruthIssue[];
}

/** Truth-check a draft, render files, build the fill plan, and set Ready or Needs input. */
export async function completePrep(
  deps: PrepDeps,
  i: PrepInputs,
  draft: Draft,
): Promise<PrepOutcome> {
  const { store, profile } = deps;
  const context = `${i.posting.company}\n${i.posting.title}\n${i.posting.descriptionText ?? ""}`;
  const applied = applyResumePlan(profile, draft.resumePlan);
  let doc = applied.doc;
  if (doc.experience.length + doc.projects.length === 0) doc = buildBaseResume(profile);

  const claims: ClaimToCheck[] = [
    ...[...doc.experience, ...doc.projects].flatMap((e) =>
      e.bullets.map((b, n) => ({
        where: `bullet:${e.id}:${n}`,
        text: b.text,
        factIds: b.factIds,
        mustCite: true,
      })),
    ),
    ...draft.answers.map((a) => ({
      where: `answer:${a.questionKey}`,
      text: a.text,
      factIds: a.factIds,
      mustCite: false,
      context,
    })),
    ...(draft.coverLetter ?? []).map((p, n) => ({
      where: `cover:${n}`,
      text: p.text,
      factIds: p.factIds,
      mustCite: false,
      context,
    })),
  ];
  const issues = checkClaims(profile, claims);
  // Writing rules, on the same texts the truth check sees. A bullet that breaks one goes back
  // to your own wording; an answer or cover letter that breaks one is flagged for you.
  for (const w of checkWriting(claims, profileOwnWords(profile)))
    issues.push({ where: w.where, problem: w.problem, severity: "block" });
  for (const note of voiceNotes(
    deps.voice ?? null,
    (draft.coverLetter ?? []).map((p) => p.text).join("\n\n"),
  ))
    issues.push({ where: "cover:0", problem: note, severity: "warn" });
  if (deps.llm) {
    try {
      issues.push(...(await modelTruthCheck(deps.llm, profile, claims)));
    } catch (e) {
      // A failed second pass must not wave drafts through: treat every drafted text as unchecked.
      for (const c of claims.filter((c) => !c.where.startsWith("bullet:"))) {
        issues.push({
          where: c.where,
          problem: `truth check could not run (${String(e)})`,
          severity: "block",
        });
      }
    }
  }
  for (const p of applied.problems)
    issues.push({ where: `plan:${p.where}`, problem: p.problem, severity: "warn" });
  const blocked = new Set(issues.filter((x) => x.severity === "block").map((x) => x.where));
  doc = revertBlockedBullets(doc, blocked, deps);

  const dir = join(deps.outDir, String(i.app.id));
  mkdirSync(dir, { recursive: true });
  const pdf = await renderResumePdf(doc);
  const resumePath = join(dir, "resume.pdf");
  writeFileSync(resumePath, pdf);
  const parse = await parseCheckResume(pdf, doc);

  const coverFlagged = (draft.coverLetter ?? []).some((_, n) => blocked.has(`cover:${n}`));
  if (draft.coverLetter?.length) {
    writeFileSync(
      join(dir, "cover_letter.pdf"),
      await renderCoverLetterPdf(
        profile.identity.name,
        i.posting.company,
        draft.coverLetter.map((p) => p.text),
      ),
    );
  }

  store.saveResumeVariant(
    i.app.id,
    { plan: draft.resumePlan, fitNote: draft.fitNote, issues, doc },
    resumePath,
    diffResume(buildBaseResume(profile), doc),
    parse,
  );

  const limits = new Map(i.questions.map((q) => [q.key, q.maxLength ?? null]));
  const drafted = new Map<string, DraftedAnswer>();
  const rows: Parameters<Store["replaceDrafts"]>[1] = draft.answers.map((a) => {
    const over = (limits.get(a.questionKey) ?? Infinity) < a.text.length;
    const own = issues.filter((x) => x.where === `answer:${a.questionKey}`);
    const flagged = over || own.some((x) => x.severity === "block");
    drafted.set(a.questionKey, { questionKey: a.questionKey, text: a.text, flagged });
    const q = i.questions.find((x) => x.key === a.questionKey);
    return {
      kind: "answer",
      question_key: a.questionKey,
      question_text: q?.label ?? null,
      text: a.text,
      cited_fact_ids: a.factIds,
      checker_status: flagged ? "flagged" : "pass",
      checker_notes: [
        ...own.map((x) => x.problem),
        ...(over ? ["longer than the field allows"] : []),
      ],
    };
  });
  if (draft.coverLetter?.length) {
    rows.push({
      kind: "cover_letter",
      question_key: null,
      question_text: null,
      text: draft.coverLetter.map((p) => p.text).join("\n\n"),
      cited_fact_ids: [...new Set(draft.coverLetter.flatMap((p) => p.factIds))],
      checker_status: coverFlagged ? "flagged" : "pass",
      checker_notes: issues.filter((x) => x.where.startsWith("cover:")).map((x) => x.problem),
    });
  }
  store.replaceDrafts(i.app.id, rows);

  const plan = buildFillPlan(i.questions, profile, drafted, store.learnedAnswers(), {
    coverLetter: Boolean(draft.coverLetter?.length) && !coverFlagged,
  });
  store.replaceFieldFills(i.app.id, plan);
  store.logEvent(i.app.id, "prepared", { issues: issues.length, parseOk: parse.ok });

  const status = hasBlockingFlags(plan) || !parse.ok || coverFlagged ? "needs_input" : "ready";
  const current = store.getApplication(i.app.id)!;
  if (current.status !== status) store.setStatus(i.app.id, status);
  return { applicationId: i.app.id, status, issues };
}

export async function prepareOne(
  deps: PrepDeps,
  posting: Posting,
  tier: Tier,
): Promise<PrepOutcome> {
  const inputs = prepInputs(deps, posting, tier);
  if (!deps.llm) return completePrep(deps, inputs, offlineDraft(deps));
  const req = draftRequest(deps, inputs);
  let draft = await draftApplication(deps.llm, req);
  // One redraft if the model broke the writing rules; anything left is flagged in review.
  const broken = writingIssuesFor(deps, draft);
  if (broken.length) {
    deps.store.logEvent(inputs.app.id, "redraft_for_writing", {
      problems: broken.map((b) => `${b.where}: ${b.match}`),
    });
    draft = await draftApplication(deps.llm, {
      ...req,
      revisionNotes: broken.map((b) => `${b.where}: ${b.problem}`),
    });
  }
  return completePrep(deps, inputs, draft);
}

export interface PrepSelection {
  posting: Posting;
  tier: Tier;
}

/**
 * The next postings worth preparing: best score first, Tier A and B only, no existing
 * application, and at most `per_company_cap` live applications per company.
 */
export function selectForPrep(
  deps: PrepDeps,
  opts: { limit?: number; tiers?: Tier[] } = {},
): PrepSelection[] {
  const { store, profile } = deps;
  const tiers = opts.tiers ?? ["A", "B"];
  const cap = profile.preferences.per_company_cap;
  const perCompany = new Map<string, number>();
  const out: PrepSelection[] = [];
  const inBatch = new Set(store.openBatches().flatMap((b) => b.application_ids));
  for (const { posting, score } of store.rankedCandidates(5000)) {
    if (out.length >= (opts.limit ?? 25)) break;
    const tier = score.fit?.tier;
    if (!tier || !tiers.includes(tier)) continue;
    const existing = store.applicationForPosting(posting.id);
    if (existing && inBatch.has(existing.id)) continue; // a Message Batch will finish it
    // An application left in "prepared" by a failed run is retried, outside the company cap.
    if (existing?.status === "prepared") {
      out.push({ posting, tier: existing.tier });
      continue;
    }
    if (existing) continue;
    const c = normalizeCompany(posting.company);
    const used = perCompany.get(c) ?? store.countActiveForCompany(c);
    if (used >= cap) continue;
    perCompany.set(c, used + 1);
    out.push({ posting, tier });
  }
  return out;
}

/**
 * Is this posting still open? An expired one is skipped (and its application, if a failed run
 * left one, is marked skipped). Uncertain answers keep the posting.
 */
export async function stillOpen(deps: PrepDeps, posting: Posting): Promise<boolean> {
  if (!deps.liveness) return true;
  const r = await ensureOpen(
    deps.store,
    posting,
    deps.liveness,
    PREP_RECHECK_MS,
    deps.now?.() ?? new Date(),
  );
  if (r.verdict !== "expired") return true;
  deps.log?.(`skipped ${posting.company}: ${posting.title} (closed: ${r.reason})`);
  const app = deps.store.applicationForPosting(posting.id);
  if (
    app &&
    (app.status === "prepared" || app.status === "needs_input" || app.status === "ready")
  ) {
    deps.store.setStatus(app.id, "skipped");
    deps.store.logEvent(app.id, "posting_closed", { code: r.code, reason: r.reason });
  }
  return false;
}

export async function runPrep(
  deps: PrepDeps,
  opts: { limit?: number; tiers?: Tier[] } = {},
): Promise<{
  prepared: number;
  ready: number;
  needsInput: number;
  failed: number;
  closed: number;
}> {
  const report = { prepared: 0, ready: 0, needsInput: 0, failed: 0, closed: 0 };
  const limit = opts.limit ?? 25;
  // Look further down the list than the limit, so closed postings don't shrink the run.
  const pool = selectForPrep(deps, { ...opts, limit: deps.liveness ? limit * 3 + 5 : limit });
  for (const s of pool) {
    if (report.prepared + report.failed >= limit) break;
    if (!(await stillOpen(deps, s.posting))) {
      report.closed++;
      continue;
    }
    try {
      const r = await prepareOne(deps, s.posting, s.tier);
      report.prepared++;
      if (r.status === "ready") report.ready++;
      else report.needsInput++;
    } catch (e) {
      report.failed++;
      deps.log?.(`prep failed for ${s.posting.id}: ${String(e)}`);
    }
  }
  return report;
}

export function resumePathFor(
  outDir: string,
  applicationId: number,
  kind: "resume" | "cover_letter",
): string {
  return join(outDir, String(applicationId), `${kind}.pdf`);
}
