import type {
  CoverLetterBase,
  FormQuestion,
  Posting,
  Profile,
  ResumePlan,
  Tier,
  VoiceTraits,
} from "@ia/core";
import {
  ADDED_PARAGRAPH_WORDS,
  coverLetterBaseForModel,
  voicePrompt,
  writingRulesPrompt,
} from "@ia/core";
import { z } from "zod";
import type { Effort, LlmClient, LlmRequest, ModelId } from "./client.ts";
import { MODELS } from "./client.ts";
import { profileForModel } from "./profile-context.ts";

const Cited = z.object({
  text: z.string(),
  fact_ids: z.array(z.string()).describe("Ids of the candidate facts this text rests on"),
});

export const DraftSchema = z.object({
  resume: z.object({
    entries: z
      .array(z.object({ entry_id: z.string(), bullets: z.array(Cited) }))
      .describe(
        "Entries to show, most relevant first. Each bullet rewords facts from that entry only.",
      ),
    skills_order: z
      .array(z.string())
      .describe("The candidate's own skills, most relevant first. Never add one."),
    courses: z
      .array(z.string())
      .describe("Up to 4 of the candidate's own courses most relevant to this role"),
  }),
  answers: z.array(
    z.object({
      question_key: z.string(),
      text: z.string(),
      fact_ids: z.array(z.string()),
    }),
  ),
  cover_letter: z
    .array(Cited)
    .nullable()
    .describe("Paragraphs, or null when no cover letter was asked for"),
  fit_note: z.object({
    why: z.string().describe("One or two sentences on why this posting fits the candidate"),
    gaps: z.string().describe("What the posting asks for that the candidate's facts don't show"),
  }),
});
export type DraftOutput = z.infer<typeof DraftSchema>;

export interface DraftRequest {
  profile: Profile;
  posting: Posting;
  tier: Tier;
  /** Only the open-ended questions; known fields never go to the model. */
  openQuestions: FormQuestion[];
  coverLetter: boolean;
  /** Tier B drafting model. Defaults to Opus; Sonnet only if the user opts in. */
  model?: ModelId;
  /** Numbers measured from your writing samples; shapes cover letters and answers only. */
  voice?: VoiceTraits | null;
  /** Writing-rule problems in the previous draft, for a redraft. */
  revisionNotes?: string[];
  /** Your own cover letter (style.cover_letter_base): the model adds one paragraph to it. */
  coverBase?: CoverLetterBase | null;
}

export interface Draft {
  resumePlan: ResumePlan;
  answers: { questionKey: string; text: string; factIds: string[] }[];
  coverLetter: { text: string; factIds: string[] }[] | null;
  fitNote: { why: string; gaps: string };
}

/** Frozen per profile, so it is cached across every posting drafted with it. */
export function draftSystemPrompt(
  profile: Profile,
  voice: VoiceTraits | null = null,
  coverBase: CoverLetterBase | null = null,
): string {
  const entries = [...profile.experience, ...profile.projects]
    .map((e) => `- ${e.id}: facts ${e.facts.map((f) => f.id).join(", ")}`)
    .join("\n");
  const [minW, maxW] = profile.style.cover_letter_words;
  const original = profile.style.resume_wording === "original";
  return `You prepare internship application materials from a candidate's verified facts.

Rules, in order of importance:
1. Never invent. Every sentence must rest on the candidate facts below and cite their ids in fact_ids.
   No new skills, tools, employers, titles, dates, numbers, results or awards.
2. Numbers may appear only if copied exactly from a fact's "verified number".
3. Never describe a skill above its listed level. "coursework" and "familiar" skills are never "proficient" or "expert".
${
  original
    ? `4. Resume: the candidate keeps their own wording. Never reword, shorten or merge a bullet.
   For each entry, list its bullets most relevant to this posting first. Each bullet cites exactly one fact and its text is that fact's text, copied exactly.
5. A resume bullet may cite only facts from its own entry.`
    : `4. You may choose, reorder, shorten and reword facts to match the posting's language, and drop weak ones.
5. A resume bullet may cite only facts from its own entry. Keep the resume to what fits one page: at most 4 bullets per entry.`
}
6. Answers: specific and plain. A line about why the company appeals may cite no fact if it only restates the posting.
   If a question can't be answered truthfully from the facts, answer with an empty string; the candidate will write it.
7. Respect each question's character limit.
${
  coverBase
    ? `8. Cover letter, when asked: the candidate wrote their own letter (it comes with the request) and it is sent word for word. Don't rewrite or repeat it.
   Write exactly one short paragraph to add to it for this posting: 2 or 3 sentences, at most ${ADDED_PARAGRAPH_WORDS} words.
   Name the company and the role, and connect one or two of the candidate's facts to something specific the posting asks for.
   Match the letter's voice. It goes before the letter's last paragraph. Return it as the only item in cover_letter.`
    : `8. Cover letter, when asked: ${minW} to ${maxW} words, 3 or 4 paragraphs, no greeting or sign-off lines.`
}
Voice: ${profile.style.voice}.

${writingRulesPrompt()}

${voicePrompt(voice)}

Entries and their fact ids:
${entries}

${profileForModel(profile)}`;
}

function draftUserPrompt(req: DraftRequest): string {
  const qs = req.openQuestions.length
    ? req.openQuestions
        .map(
          (q) =>
            `- key: ${q.key}\n  question: ${q.label}${q.maxLength ? `\n  limit: ${q.maxLength} characters` : ""}`,
        )
        .join("\n")
    : "(none)";
  return `<posting>
Company: ${req.posting.company}
Role: ${req.posting.title}
Locations: ${req.posting.locations.join("; ")}

${(req.posting.descriptionText ?? "(no description available; tailor to the title only)").slice(0, 14000)}
</posting>

Open questions to answer:
${qs}

Cover letter wanted: ${req.coverLetter ? "yes" : "no"}${
    // Your letter goes only to drafts that write a cover letter, so its claims can't leak into
    // answers elsewhere.
    req.coverLetter && req.coverBase
      ? `

The candidate's own cover letter, sent as written. It is not a source of facts: never repeat a claim
from it in your paragraph unless a candidate fact says the same.
<letter>
${coverLetterBaseForModel(req.coverBase)}
</letter>`
      : ""
  }${
    req.revisionNotes?.length
      ? `

Your previous draft broke these writing rules. Write the whole draft again without them, keeping every fact and citation:
${req.revisionNotes.map((n) => `- ${n}`).join("\n")}`
      : ""
  }`;
}

export function effortFor(tier: Tier): Effort {
  return tier === "A" ? "high" : "medium";
}

/** The exact request live drafting sends; the Batch API path sends the same one. */
export function draftLlmRequest(req: DraftRequest): LlmRequest<DraftOutput> {
  return {
    purpose: "draft",
    model: req.model ?? MODELS.opus,
    effort: effortFor(req.tier),
    maxTokens: 16000,
    system: draftSystemPrompt(req.profile, req.voice ?? null, req.coverBase ?? null),
    user: draftUserPrompt(req),
    schema: DraftSchema,
  };
}

export async function draftApplication(llm: LlmClient, req: DraftRequest): Promise<Draft> {
  const res = await llm.generate(draftLlmRequest(req));
  return fromDraftOutput(res.data, req);
}

/** Convert the model's output; drop answers to questions that weren't asked. */
export function fromDraftOutput(
  d: DraftOutput,
  req: Pick<DraftRequest, "openQuestions" | "coverLetter">,
): Draft {
  const asked = new Set(req.openQuestions.map((q) => q.key));
  return {
    resumePlan: {
      entries: d.resume.entries.map((e) => ({
        entryId: e.entry_id,
        bullets: e.bullets.map((b) => ({ text: b.text, factIds: b.fact_ids })),
      })),
      skillsOrder: d.resume.skills_order,
      courses: d.resume.courses,
    },
    answers: d.answers
      .filter((a) => asked.has(a.question_key) && a.text.trim().length > 0)
      .map((a) => ({ questionKey: a.question_key, text: a.text.trim(), factIds: a.fact_ids })),
    coverLetter:
      req.coverLetter && d.cover_letter
        ? d.cover_letter.map((p) => ({ text: p.text, factIds: p.fact_ids }))
        : null,
    fitNote: d.fit_note,
  };
}
