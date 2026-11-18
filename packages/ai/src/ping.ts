import { z } from "zod";
import type { LlmClient } from "./client.ts";
import { MODELS } from "./client.ts";

const PingSchema = z.object({ ok: z.boolean() });

/** One tiny call (Haiku, a few tokens) to prove a provider works. */
export async function testConnection(
  llm: LlmClient,
): Promise<{ ok: true; model: string; ms: number } | { ok: false; error: string }> {
  const t0 = Date.now();
  try {
    const r = await llm.generate({
      purpose: "connection_test",
      model: MODELS.haiku,
      effort: "low",
      maxTokens: 50,
      system: 'Reply with the JSON {"ok": true} and nothing else.',
      user: "Connection test.",
      schema: PingSchema,
    });
    return { ok: true, model: r.model, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
