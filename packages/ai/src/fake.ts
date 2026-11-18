import type { LlmClient, LlmRequest, LlmResult } from "./client.ts";

/**
 * A scripted LLM for tests and offline demos. Each handler gets the request and returns the
 * data it should "generate". Every request is recorded so tests can assert what was sent.
 */
export class FakeLlm implements LlmClient {
  readonly requests: LlmRequest<unknown>[] = [];
  constructor(private readonly handlers: Record<string, (req: LlmRequest<unknown>) => unknown>) {}

  async generate<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    this.requests.push(req as LlmRequest<unknown>);
    const h = this.handlers[req.purpose];
    if (!h) throw new Error(`FakeLlm has no handler for purpose "${req.purpose}"`);
    const data = req.schema.parse(h(req as LlmRequest<unknown>));
    return {
      data,
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0 },
      model: req.model,
      stopReason: "end_turn",
    };
  }
}
