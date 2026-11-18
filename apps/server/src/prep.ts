import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ClaimToCheck,
  CoverLetterBase,
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
  ADDED_PARAGRAPH_HARD_CAP,
  applyResumePlan,
  assembleCoverLetter,
  buildBaseResume,
  buildFillPlan,
  checkClaims,
  checkWriting,
  classifyQuestion,
  diffResume,
  hasBlockingFlags,
  indexFacts,
  normalizeCompany,
  orderBaseResume,
  profileOwnWords,
  questionKey,
  STANDARD_QUESTIONS,
  voiceNotes,
  wordCount,
} from "@ia/core";
import type { Draft, DraftRequest } from "@ia/ai";
import { draftApplication, MODELS, modelTruthCheck, stopsTheRun, UsageLimitError } from "@ia/ai";
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
  /** Your own cover letter (style.cover_letter_base), used word for word plus one paragraph. */
  coverBase?: CoverLetterBase | null;
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

function nothingToWrite(deps: PrepDeps, i: PrepInputs): boolean {
  return (
    deps.profile.style.resume_wording === "original" && i.openToDraft.length === 0 && !i.coverLetter
  );
}

export function draftRequest(deps: PrepDeps, i: PrepInputs): DraftRequest {
  return {
    profile: deps.profile,
    posting: i.posting,
    tier: i.tier,
    openQuestions: i.openToDraft,
    coverLetter: i.coverLetter,
    voice: deps.voice ?? null,
    coverBase: deps.coverBase ?? null,
    // With your own resume wording, no open questions and no cover letter, the model only orders
    // bullets and writes the fit note: Haiku does that for a fraction of the cost.
    ...(nothingToWrite(deps, i)
      ? { model: MODELS.haiku }
      : i.tier === "B" && deps.tierBModel
        ? { model: deps.tierBModel }
        : {}),
  };
}

const keepsOwnBullets = (deps: Pick<PrepDeps, "profile">) =>
  deps.profile.style.resume_wording === "original";

/** Text the writing check treats as yours: your facts, entry names and your own letter. */
function ownWords(deps: PrepDeps): string {
  const base = deps.coverBase ? `\n${deps.coverBase.paragraphs.join("\n")}` : "";
  return profileOwnWords(deps.profile) + base;
}

/** Every generated text in a draft, labelled the same way the truth check labels it. */
export function draftTexts(
  draft: Draft,
  opts: { ownBullets?: boolean } = {},
): { where: string; text: string }[] {
  return [
    ...(opts.ownBullets ? [] : draft.resumePlan.entries).flatMap((e) =>
      e.bullets.map((b, n) => ({ where: `bullet:${e.entryId}:${n}`, text: b.text })),
    ),
    ...draft.answers.map((a) => ({ where: `answer:${a.questionKey}`, text: a.text })),
    ...(draft.coverLetter ?? []).map((p, n) => ({ where: `cover:${n}`, text: p.text })),
  ];
}

export function writingIssuesFor(deps: PrepDeps, draft: Draft): WritingIssue[] {
  return checkWriting(draftTexts(draft, { ownBullets: keepsOwnBullets(deps) }), ownWords(deps));
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
  const ownBullets = keepsOwnBullets(deps);
  const applied = ownBullets
    ? { doc: orderBaseResume(profile, draft.resumePlan), problems: [] }
    : applyResumePlan(profile, draft.resumePlan);
  let doc = applied.doc;
  if (doc.experience.length + doc.projects.length === 0) doc = buildBaseResume(profile);
  // With your own letter, the model's only text is one added paragraph.
  const base = i.coverLetter ? (deps.coverBase ?? null) : null;
  const added =
    base && draft.coverLetter?.length
      ? {
          text: draft.coverLetter.map((p) => p.text.trim()).join(" "),
          factIds: [...new Set(draft.coverLetter.flatMap((p) => p.factIds))],
        }
      : null;

  const claims: ClaimToCheck[] = [
    // Bullets in your own words need no check: they are your facts, verbatim.
    ...(ownBullets ? [] : [...doc.experience, ...doc.projects]).flatMap((e) =>
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
    ...(base
      ? added
        ? [
            {
              where: "cover:add",
              text: added.text,
              factIds: added.factIds,
              mustCite: false,
              context,
            },
          ]
        : []
      : (draft.coverLetter ?? []).map((p, n) => ({
          where: `cover:${n}`,
          text: p.text,
          factIds: p.factIds,
          mustCite: false,
          context,
        }))),
  ];
  const issues = checkClaims(profile, claims);
  if (added && wordCount(added.text) > ADDED_PARAGRAPH_HARD_CAP)
    issues.push({
      where: "cover:add",
      problem: `the added paragraph is ${wordCount(added.text)} words; the limit is ${ADDED_PARAGRAPH_HARD_CAP}`,
      severity: "block",
    });
  // Writing rules, on the same texts the truth check sees. A bullet that breaks one goes back
  // to your own wording; an answer or cover letter that breaks one is flagged for you.
  for (const w of checkWriting(claims, ownWords(deps)))
    issues.push({ where: w.where, problem: w.problem, severity: "block" });
  for (const note of base
    ? []
    : voiceNotes(deps.voice ?? null, (draft.coverLetter ?? []).map((p) => p.text).join("\n\n")))
    issues.push({ where: "cover:0", problem: note, severity: "warn" });
  if (deps.llm) {
    try {
      issues.push(...(await modelTruthCheck(deps.llm, profile, claims)));
    } catch (e) {
      if (stopsTheRun(e)) throw e;
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

  // Your letter never waits on the model: a paragraph that fails a check is left out, and the
  // letter goes as you wrote it.
  const addedOk = Boolean(added) && !blocked.has("cover:add");
  if (added && !addedOk)
    for (const x of issues)
      if (x.where === "cover:add" && x.severity === "block") {
        x.severity = "warn";
        x.problem = `added paragraph left out: ${x.problem}`;
      }
  const letter: { paragraphs: string[]; factIds: string[] } | null = base
    ? {
        paragraphs: assembleCoverLetter(base, addedOk ? added!.text : null),
        factIds: addedOk ? added!.factIds : [],
      }
    : draft.coverLetter?.length
      ? {
          paragraphs: draft.coverLetter.map((p) => p.text),
          factIds: [...new Set(draft.coverLetter.flatMap((p) => p.factIds))],
        }
      : null;

  const dir = join(deps.outDir, String(i.app.id));
  mkdirSync(dir, { recursive: true });
  const pdf = await renderResumePdf(doc);
  const resumePath = join(dir, "resume.pdf");
  writeFileSync(resumePath, pdf);
  const parse = await parseCheckResume(pdf, doc);

  const coverFlagged = !base && (draft.coverLetter ?? []).some((_, n) => blocked.has(`cover:${n}`));
  if (letter) {
    writeFileSync(
      join(dir, "cover_letter.pdf"),
      await renderCoverLetterPdf(profile.identity.name, i.posting.company, letter.paragraphs, {
        greeting: base?.greeting ?? null,
        closing: base?.closing ?? null,
      }),
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
  if (letter) {
    rows.push({
      kind: "cover_letter",
      question_key: null,
      question_text: null,
      text: letter.paragraphs.join("\n\n"),
      cited_fact_ids: letter.factIds,
      checker_status: coverFlagged ? "flagged" : "pass",
      checker_notes: issues.filter((x) => x.where.startsWith("cover:")).map((x) => x.problem),
    });
  }
  store.replaceDrafts(i.app.id, rows);

  const plan = buildFillPlan(i.questions, profile, drafted, store.learnedAnswers(), {
    coverLetter: Boolean(letter) && !coverFlagged,
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
  const limit = opts.limit ?? 25;
  const cap = profile.preferences.per_company_cap;
  const perCompany = new Map<string, number>();
  // Unfinished work first: an application left in "prepared" (a failed or interrupted run, or one
  // you sent back) is finished before any new posting is started, outside the company cap.
  const retries: PrepSelection[] = [];
  const fresh: PrepSelection[] = [];
  const inBatch = new Set(store.openBatches().flatMap((b) => b.application_ids));
  for (const { posting, score } of store.rankedCandidates(5000)) {
    if (retries.length >= limit) break;
    const existing = store.applicationForPosting(posting.id);
    if (existing && inBatch.has(existing.id)) continue; // a Message Batch will finish it
    if (existing?.status === "prepared") {
      if (tiers.includes(existing.tier)) retries.push({ posting, tier: existing.tier });
      continue;
    }
    if (existing || fresh.length >= limit) continue;
    const tier = score.fit?.tier;
    if (!tier || !tiers.includes(tier)) continue;
    const c = normalizeCompany(posting.company);
    const used = perCompany.get(c) ?? store.countActiveForCompany(c);
    if (used >= cap) continue;
    perCompany.set(c, used + 1);
    fresh.push({ posting, tier });
  }
  return [...retries, ...fresh].slice(0, limit);
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
  /** True when the run stopped early at the subscription's usage limit. */
  paused: boolean;
  /** Why the run stopped early, if it did. */
  stopped: string | null;
}> {
  const report = {
    prepared: 0,
    ready: 0,
    needsInput: 0,
    failed: 0,
    closed: 0,
    paused: false,
    stopped: null as string | null,
  };
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
      // The subscription's usage limit, or a missing or signed-out CLI: stop here instead of
      // failing every posting in turn. Unfinished applications stay "prepared" and go first next run.
      if (stopsTheRun(e)) {
        report.stopped = e.message;
        report.paused = e instanceof UsageLimitError;
        break;
      }
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
