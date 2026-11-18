import type { FormQuestion, Posting, Profile, ResumePlan, Tier } from "@ia/core";
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
}

export interface Draft {
  resumePlan: ResumePlan;
  answers: { questionKey: string; text: string; factIds: string[] }[];
  coverLetter: { text: string; factIds: string[] }[] | null;
  fitNote: { why: string; gaps: string };
}

/** Frozen per profile, so it is cached across every posting drafted with it. */
export function draftSystemPrompt(profile: Profile): string {
  const entries = [...profile.experience, ...profile.projects]
    .map((e) => `- ${e.id}: facts ${e.facts.map((f) => f.id).join(", ")}`)
    .join("\n");
  const [minW, maxW] = profile.style.cover_letter_words;
  return `You prepare internship application materials from a candidate's verified facts.

Rules, in order of importance:
1. Never invent. Every sentence must rest on the candidate facts below and cite their ids in fact_ids.
   No new skills, tools, employers, titles, dates, numbers, results or awards.
2. Numbers may appear only if copied exactly from a fact's "verified number".
3. Never describe a skill above its listed level. "coursework" and "familiar" skills are never "proficient" or "expert".
4. You may choose, reorder, shorten and reword facts to match the posting's language, and drop weak ones.
5. A resume bullet may cite only facts from its own entry. Keep the resume to what fits one page: at most 4 bullets per entry.
6. Answers: specific and plain. A line about why the company appeals may cite no fact if it only restates the posting.
   If a question can't be answered truthfully from the facts, answer with an empty string; the candidate will write it.
7. Respect each question's character limit.
8. Cover letter, when asked: ${minW} to ${maxW} words, 3 or 4 paragraphs, no greeting or sign-off lines.
Voice: ${profile.style.voice}.

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

Cover letter wanted: ${req.coverLetter ? "yes" : "no"}`;
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
    system: draftSystemPrompt(req.profile),
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
