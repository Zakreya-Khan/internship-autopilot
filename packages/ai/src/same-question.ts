import { z } from "zod";
import type { LlmClient } from "./client.ts";
import { MODELS } from "./client.ts";

export const SameQuestionSchema = z.object({
  same: z
    .boolean()
    .describe("True only if one honest answer would fit both questions exactly as asked"),
});

const SYSTEM = `You compare two questions from job application forms.
Decide whether they ask the same thing, so that one honest answer fits both exactly as asked.
Different wording is fine. Different scope is not: a different place, time, duration, company,
number, or a broader or narrower question means they are not the same.
When unsure, say they are not the same.`;

/**
 * Do two form questions ask the same thing? Haiku, a few tokens. Only the two question texts are
 * sent: never your answer, your profile or the posting.
 */
export async function sameQuestion(llm: LlmClient, a: string, b: string): Promise<boolean> {
  const r = await llm.generate({
    purpose: "question_match",
    model: MODELS.haiku,
    effort: "low",
    maxTokens: 100,
    system: SYSTEM,
    user: `<question_a>${a.slice(0, 600)}</question_a>\n<question_b>${b.slice(0, 600)}</question_b>`,
    schema: SameQuestionSchema,
  });
  return r.data.same;
}
