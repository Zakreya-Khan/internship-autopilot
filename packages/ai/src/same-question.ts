import { z } from "zod";
import type { LlmClient } from "./client.ts";
import { MODELS } from "./client.ts";

export const SameQuestionSchema = z.object({
  same: z.boolean().describe("True if the answer a person gave to one would also answer the other"),
});

const SYSTEM = `You compare two questions from job application forms.
Say they are the same when the answer someone gave to one would also be a true, complete answer
to the other. Different wording, politeness or slight differences in phrasing are fine
("When can you start?" and "What is your earliest start date?" are the same).
They are different when they ask about a different topic, place, time, duration, company or
number, or when one asks for something the other doesn't (an employer vs. a relative there).
The person still confirms every match, so judge plainly.`;

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
