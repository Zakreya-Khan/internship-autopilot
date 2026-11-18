import { containsTerm, indexFacts } from "@ia/core";
import type { Posting, Profile, RequirementMatch } from "@ia/core";
import { z } from "zod";
import type { LlmClient } from "./client.ts";
import { MODELS } from "./client.ts";
import { profileForModel } from "./profile-context.ts";

export const RequirementsSchema = z.object({
  required: z
    .array(z.string())
    .describe("Skills, tools or qualifications the posting asks for, short names, at most 12"),
  matched: z
    .array(z.string())
    .describe("Items from `required` that the candidate's listed skills or facts clearly support"),
});

const SYSTEM = `You compare internship postings with a candidate profile.
List what the posting asks for (skills, tools, qualifications), as short names.
Mark an item matched only if the candidate's listed skills or facts clearly support it. Do not guess.`;

/**
 * Model-based requirement match, with a code-side guard: a "matched" item counts only if the
 * term actually appears in the profile's skills, tools or fact text.
 */
export async function matchRequirements(
  llm: LlmClient,
  posting: Posting,
  profile: Profile,
): Promise<RequirementMatch> {
  const res = await llm.generate({
    purpose: "requirements",
    model: MODELS.haiku,
    effort: "low",
    maxTokens: 2000,
    system: `${SYSTEM}\n\n${profileForModel(profile)}`,
    user: `<posting>\nTitle: ${posting.title}\nCompany: ${posting.company}\n\n${(posting.descriptionText ?? "").slice(0, 12000)}\n</posting>`,
    schema: RequirementsSchema,
  });
  const profileText = [
    ...profile.skills.map((s) => s.name),
    ...[...indexFacts(profile).values()].flatMap((f) => [f.text, ...f.tools]),
    ...profile.education.flatMap((e) => [e.major, e.degree, ...e.courses]),
  ].join("\n");
  const required = [...new Set(res.data.required.map((r) => r.trim()).filter(Boolean))].slice(
    0,
    12,
  );
  const matched = res.data.matched.filter(
    (m) =>
      required.some((r) => r.toLowerCase() === m.toLowerCase()) && containsTerm(profileText, m),
  );
  const missing = required.filter((r) => !matched.some((m) => m.toLowerCase() === r.toLowerCase()));
  return { required, matched, missing, method: "model" };
}
