// Recruiter and referral message drafts. Draft only: this tool never sends a message, looks a
// person up, or touches LinkedIn. You choose who gets it and send it yourself.
// Structure (three sentences, a hard length cap) adapted from career-ops (MIT, see NOTICE).
import type { Posting, Profile } from "@ia/core";
import { writingRulesPrompt } from "@ia/core";
import { z } from "zod";
import type { LlmClient } from "./client.ts";
import { MODELS } from "./client.ts";
import { profileForModel } from "./profile-context.ts";

export type OutreachKind = "recruiter" | "referral";

export const OUTREACH_MAX_CHARS = 300;

export const OutreachSchema = z.object({
  message: z.string(),
  fact_ids: z.array(z.string()),
});

const SHAPES: Record<OutreachKind, string> = {
  recruiter:
    "1) Fit: the role by name and one line on why you match it. 2) Proof: your single strongest fact that answers what the posting asks for. 3) Ask: offer to share your resume if it aligns with what they're looking for.",
  referral:
    "1) Context: you're applying to this role at their company (no invented shared history; leave a [how you know them] placeholder for the candidate to fill in). 2) Bridge: one fact that shows the fit. 3) Ask: would they be willing to refer you or pass your resume along.",
};

export async function draftOutreach(
  llm: LlmClient,
  profile: Profile,
  posting: Posting,
  kind: OutreachKind,
): Promise<{ message: string; factIds: string[] }> {
  const res = await llm.generate({
    purpose: "outreach",
    model: MODELS.opus,
    effort: "low",
    maxTokens: 2000,
    system: `You draft a short message a student will send themselves to a ${kind === "recruiter" ? "recruiter" : "person who might refer them"}.
Exactly three sentences, at most ${OUTREACH_MAX_CHARS} characters in total, no greeting line or sign-off.
${SHAPES[kind]}
Cite the fact ids you used. Never invent a fact, number, mutual connection or prior conversation.
Never mention a phone number. Never write "I'm passionate about" or "I'm looking for a job".

${writingRulesPrompt()}

${profileForModel(profile)}`,
    user: `Company: ${posting.company}\nRole: ${posting.title}\n\n${(posting.descriptionText ?? "").slice(0, 4000)}`,
    schema: OutreachSchema,
  });
  return { message: res.data.message.trim(), factIds: res.data.fact_ids };
}
