import { indexFacts } from "@ia/core";
import type { ClaimToCheck, Profile, TruthIssue } from "@ia/core";
import { z } from "zod";
import type { LlmClient } from "./client.ts";
import { MODELS } from "./client.ts";

export const TruthCheckSchema = z.object({
  verdicts: z.array(
    z.object({
      where: z.string(),
      supported: z
        .boolean()
        .describe("True only if every claim in the text is supported by its cited facts"),
      problem: z.string().describe("The unsupported claim, quoted, or an empty string"),
    }),
  ),
});

const SYSTEM = `You are a strict fact checker for job application materials.
For each item, decide whether every factual claim in the text is supported by the facts it cites.
Rewording, shortening and emphasis are fine. Anything new is not: an added skill, tool, result, number,
title, responsibility, team size, or a stronger level of skill than the facts show.
Statements of interest or motivation that make no factual claim about the candidate are supported.
Judge only against the cited facts given. Be strict; when unsure, mark it unsupported.`;

/**
 * Second pass, separate from drafting: the checker sees only each text and its cited facts,
 * not the posting or the drafting instructions.
 */
export async function modelTruthCheck(
  llm: LlmClient,
  profile: Profile,
  claims: ClaimToCheck[],
): Promise<TruthIssue[]> {
  if (claims.length === 0) return [];
  const facts = indexFacts(profile);
  const items = claims
    .map((c) => {
      const cited =
        c.factIds.map((id) => `  - ${id}: ${facts.get(id)?.text ?? "(unknown id)"}`).join("\n") ||
        "  (no facts cited)";
      return `<item where="${c.where}">\nText: ${c.text}\nCited facts:\n${cited}\n</item>`;
    })
    .join("\n");
  const res = await llm.generate({
    purpose: "truth_check",
    model: MODELS.opus,
    effort: "low",
    maxTokens: 8000,
    system: SYSTEM,
    user: items,
    schema: TruthCheckSchema,
  });
  const known = new Set(claims.map((c) => c.where));
  return res.data.verdicts
    .filter((v) => known.has(v.where) && !v.supported)
    .map((v) => ({
      where: v.where,
      problem: v.problem || "the checker found an unsupported claim",
      severity: "block" as const,
    }));
}
