import type { Profile, StarStory } from "@ia/core";
import { writingRulesPrompt } from "@ia/core";
import { z } from "zod";
import type { LlmClient } from "./client.ts";
import { MODELS } from "./client.ts";
import { profileForModel } from "./profile-context.ts";

export const StoriesSchema = z.object({
  stories: z.array(
    z.object({
      title: z.string(),
      situation: z.string(),
      task: z.string(),
      action: z.string(),
      result: z.string(),
      best_for: z.array(z.string()).describe("Interview questions this story answers"),
      fact_ids: z.array(z.string()),
    }),
  ),
});

/** Draft 5 to 10 STAR stories from the candidate's facts. Code checks them afterwards. */
export async function draftStories(
  llm: LlmClient,
  profile: Profile,
  count = 8,
): Promise<StarStory[]> {
  const res = await llm.generate({
    purpose: "stories",
    model: MODELS.opus,
    effort: "medium",
    maxTokens: 12000,
    system: `You write interview stories in STAR form (situation, task, action, result) for a student, using only their verified facts.
Rules:
1. Every story cites the fact ids it rests on. Nothing outside those facts: no new tools, numbers, results, team sizes or outcomes.
2. A number may appear only if it is written in a cited fact or its verified number.
3. If a fact gives no result, leave the result short and factual, or empty. Never invent one.
4. First person, plain, short sentences a student would say out loud.
5. Cover different interview themes: a hard problem, learning something fast, teamwork, a mistake or setback, ownership.

${writingRulesPrompt()}

${profileForModel(profile)}`,
    user: `Write ${count} stories (fewer if the facts can't support that many without repeating).`,
    schema: StoriesSchema,
  });
  return res.data.stories.map((s) => ({
    title: s.title,
    situation: s.situation,
    task: s.task,
    action: s.action,
    result: s.result,
    bestFor: s.best_for,
    factIds: s.fact_ids,
  }));
}
