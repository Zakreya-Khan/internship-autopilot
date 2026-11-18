import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { TokenUsage } from "@ia/core";
import type { z } from "zod";

export const MODELS = {
  /** Drafting and truth checks. */
  opus: "claude-opus-5-5",
  /** Optional cheaper drafting for Tier B, only if the user opts in. */
  sonnet: "claude-sonnet-5-5",
  /** Bulk classification, requirement matching, field mapping. */
  haiku: "claude-haiku-5-5",
} as const;
export type ModelId = (typeof MODELS)[keyof typeof MODELS];
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface LlmRequest<T> {
  /** For cost logging: "requirements", "draft", "truth_check", "map_fields"… */
  purpose: string;
  model: ModelId;
  effort: Effort;
  /** Frozen instructions + profile facts. Sent with cache_control so repeat calls read it from cache. */
  system: string;
  /** The per-posting part: description, questions, draft to check. */
  user: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
}

export interface LlmResult<T> {
  data: T;
  usage: TokenUsage;
  model: string;
  stopReason: string;
}

export interface LlmClient {
  generate<T>(req: LlmRequest<T>): Promise<LlmResult<T>>;
}

export class RefusalError extends Error {
  constructor(readonly category: string | null) {
    super(`The model declined this request${category ? ` (${category})` : ""}.`);
  }
}

export class TruncatedError extends Error {
  constructor() {
    super("The model's answer hit max_tokens before it finished.");
  }
}

export type UsageSink = (entry: {
  purpose: string;
  model: string;
  usage: TokenUsage;
  /** "cli" when the call ran through the Claude CLI on the user's subscription. Default "api". */
  provider?: "api" | "cli";
  /** The cost the CLI reported for this call, an estimate (the subscription covers it). */
  reportedUsd?: number;
}) => void;

/** Models that accept server-side fallback on refusals. Haiku has none. */
function supportsFallback(model: ModelId): boolean {
  return model === MODELS.opus || model === MODELS.sonnet;
}

/** Build the Messages API params for one request. Shared by live calls and the Batch API. */
export function buildParams<T>(req: LlmRequest<T>) {
  return {
    model: req.model,
    max_tokens: req.maxTokens ?? 16000,
    system: [
      { type: "text" as const, text: req.system, cache_control: { type: "ephemeral" as const } },
    ],
    messages: [{ role: "user" as const, content: req.user }],
    output_config: { effort: req.effort, format: zodOutputFormat(req.schema) },
  };
}

/** Parse a finished message: refusal and truncation are errors, text must match the schema. */
export function parseMessage<T>(
  schema: z.ZodType<T>,
  msg: {
    content: { type: string; text?: string }[];
    stop_reason: string | null;
    stop_details?: { category?: string | null } | null;
  },
): T {
  if (msg.stop_reason === "refusal") throw new RefusalError(msg.stop_details?.category ?? null);
  if (msg.stop_reason === "max_tokens") throw new TruncatedError();
  const text = msg.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  return schema.parse(JSON.parse(text));
}

/** A key to use instead of the environment's, e.g. one saved from the review UI. */
export function anthropicClient(apiKey?: string | null): Anthropic {
  return apiKey ? new Anthropic({ apiKey }) : new Anthropic();
}

export class AnthropicLlm implements LlmClient {
  constructor(
    private readonly client: Anthropic = new Anthropic(),
    private readonly onUsage?: UsageSink,
  ) {}

  async generate<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    const params = buildParams(req);
    const msg = supportsFallback(req.model)
      ? await this.client.beta.messages.create({
          ...params,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        })
      : await this.client.messages.create(params);
    const usage: TokenUsage = {
      input_tokens: msg.usage.input_tokens,
      output_tokens: msg.usage.output_tokens,
      cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
    };
    this.onUsage?.({ purpose: req.purpose, model: msg.model, usage });
    const data = parseMessage(req.schema, msg as Parameters<typeof parseMessage>[1]);
    return { data, usage, model: msg.model, stopReason: msg.stop_reason ?? "end_turn" };
  }
}

/** True when the environment has credentials the SDK will pick up on its own. */
export function hasAnthropicCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE);
}
