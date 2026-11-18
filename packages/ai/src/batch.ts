import Anthropic from "@anthropic-ai/sdk";
import type { TokenUsage } from "@ia/core";
import type { z } from "zod";
import type { LlmRequest } from "./client.ts";
import { buildParams, parseMessage } from "./client.ts";

/** The slice of the Message Batches API this tool uses. Tests supply a fake. */
export interface BatchClient {
  create(
    requests: { custom_id: string; params: ReturnType<typeof buildParams> }[],
  ): Promise<{ id: string }>;
  status(id: string): Promise<"in_progress" | "canceling" | "ended">;
  results(id: string): AsyncIterable<BatchResultLine>;
  /** Stop a batch early. Requests not yet processed end as "canceled" and are redone live. */
  cancel?(id: string): Promise<void>;
}

export type BatchResultLine =
  | {
      custom_id: string;
      type: "succeeded";
      message: Parameters<typeof parseMessage>[1] & { model: string; usage: TokenUsage };
    }
  | { custom_id: string; type: "errored" | "canceled" | "expired"; error?: string };

/** Batch requests can't carry server-side fallbacks, so refusals surface as errors to retry live. */
export function batchRequest<T>(customId: string, req: LlmRequest<T>) {
  return { custom_id: customId, params: buildParams(req) };
}

export function parseBatchLine<T>(
  schema: z.ZodType<T>,
  line: BatchResultLine,
): { ok: true; data: T; usage: TokenUsage; model: string } | { ok: false; error: string } {
  if (line.type !== "succeeded") return { ok: false, error: line.error ?? line.type };
  try {
    return {
      ok: true,
      data: parseMessage(schema, line.message),
      usage: line.message.usage,
      model: line.message.model,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export class AnthropicBatchClient implements BatchClient {
  constructor(private readonly client: Anthropic = new Anthropic()) {}

  async create(
    requests: { custom_id: string; params: ReturnType<typeof buildParams> }[],
  ): Promise<{ id: string }> {
    const b = await this.client.messages.batches.create({ requests });
    return { id: b.id };
  }

  async status(id: string): Promise<"in_progress" | "canceling" | "ended"> {
    return (await this.client.messages.batches.retrieve(id)).processing_status;
  }

  async cancel(id: string): Promise<void> {
    await this.client.messages.batches.cancel(id);
  }

  async *results(id: string): AsyncIterable<BatchResultLine> {
    for await (const r of await this.client.messages.batches.results(id)) {
      if (r.result.type === "succeeded") {
        const m = r.result.message;
        yield {
          custom_id: r.custom_id,
          type: "succeeded",
          message: {
            content: m.content as { type: string; text?: string }[],
            stop_reason: m.stop_reason,
            stop_details:
              (m as { stop_details?: { category?: string | null } | null }).stop_details ?? null,
            model: m.model,
            usage: {
              input_tokens: m.usage.input_tokens,
              output_tokens: m.usage.output_tokens,
              cache_read_input_tokens: m.usage.cache_read_input_tokens ?? 0,
              cache_creation_input_tokens: m.usage.cache_creation_input_tokens ?? 0,
            },
          },
        };
      } else {
        const error = r.result.type === "errored" ? JSON.stringify(r.result.error) : r.result.type;
        yield { custom_id: r.custom_id, type: r.result.type, error };
      }
    }
  }
}
