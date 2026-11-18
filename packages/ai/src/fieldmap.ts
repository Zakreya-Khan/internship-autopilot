import type { FillEntry, PageField } from "@ia/core";
import { z } from "zod";
import type { LlmClient } from "./client.ts";
import { MODELS } from "./client.ts";

export const FieldMapSchema = z.object({
  matches: z.array(
    z.object({
      page_key: z.string(),
      plan_key: z
        .string()
        .nullable()
        .describe("The planned question this page field asks, or null if none does"),
    }),
  ),
});

const SYSTEM = `You match the fields of a job application form on an unfamiliar website to questions
that were already answered for the same job. Match a page field to a planned question only if they
clearly ask for the same thing. Otherwise answer null. Never invent a match to fill a field.`;

/**
 * For pages no adapter knows: the model only decides which planned question a page field asks.
 * It never sees or writes values; those come from the plan. Each planned entry is used at most once.
 */
export async function mapFieldsWithModel(
  llm: LlmClient,
  unmatched: PageField[],
  plan: Pick<FillEntry, "key" | "label">[],
): Promise<Map<string, string>> {
  if (unmatched.length === 0 || plan.length === 0) return new Map();
  const res = await llm.generate({
    purpose: "map_fields",
    model: MODELS.haiku,
    effort: "low",
    maxTokens: 4000,
    system: SYSTEM,
    user: `Page fields:\n${unmatched
      .map(
        (f) =>
          `- ${f.key}: "${f.label}" (${f.type}${f.options?.length ? `; options: ${f.options.slice(0, 12).join(" | ")}` : ""})`,
      )
      .join(
        "\n",
      )}\n\nPlanned questions:\n${plan.map((p) => `- ${p.key}: "${p.label}"`).join("\n")}`,
    schema: FieldMapSchema,
  });
  const pageKeys = new Set(unmatched.map((f) => f.key));
  const planKeys = new Set(plan.map((p) => p.key));
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const m of res.data.matches) {
    if (
      !m.plan_key ||
      !pageKeys.has(m.page_key) ||
      !planKeys.has(m.plan_key) ||
      used.has(m.plan_key)
    )
      continue;
    used.add(m.plan_key);
    out.set(m.page_key, m.plan_key);
  }
  return out;
}
