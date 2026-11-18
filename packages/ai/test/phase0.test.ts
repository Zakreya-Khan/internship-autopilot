import { makePosting, testProfile } from "@ia/core/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildParams,
  FakeLlm,
  matchRequirements,
  MODELS,
  parseMessage,
  profileForModel,
  RefusalError,
  sensitiveValues,
  TruncatedError,
} from "../src/index.ts";

describe("profileForModel", () => {
  const profile = testProfile();
  const text = profileForModel(profile);

  it("includes skills and citable facts with ids", () => {
    expect(text).toContain("python: project");
    expect(text).toContain("exp.lab.f2");
    expect(text).toContain('verified number: "6 hours to 40 minutes"');
  });

  it("never includes contact details, EEO answers or GPA", () => {
    for (const v of sensitiveValues(profile)) expect(text).not.toContain(v);
    expect(text).not.toContain("alex@example.com");
    expect(text).not.toContain("protected veteran");
    expect(text).not.toContain("3.70");
  });
});

describe("request building", () => {
  it("caches the frozen system prefix and sets effort and a JSON schema", () => {
    const p = buildParams({
      purpose: "x",
      model: MODELS.opus,
      effort: "medium",
      system: "SYSTEM",
      user: "USER",
      schema: z.object({ a: z.string() }),
    });
    expect(p.system[0]).toMatchObject({ text: "SYSTEM", cache_control: { type: "ephemeral" } });
    expect(p.output_config.effort).toBe("medium");
    expect(p.output_config.format.type).toBe("json_schema");
    expect(p).not.toHaveProperty("temperature");
    expect(p).not.toHaveProperty("thinking");
  });

  it("treats refusals and truncation as errors, and validates the JSON", () => {
    const schema = z.object({ a: z.number() });
    expect(() =>
      parseMessage(schema, {
        content: [],
        stop_reason: "refusal",
        stop_details: { category: "cyber" },
      }),
    ).toThrow(RefusalError);
    expect(() =>
      parseMessage(schema, {
        content: [{ type: "text", text: '{"a":' }],
        stop_reason: "max_tokens",
      }),
    ).toThrow(TruncatedError);
    expect(
      parseMessage(schema, {
        content: [{ type: "text", text: '{"a":1}' }],
        stop_reason: "end_turn",
      }),
    ).toEqual({ a: 1 });
    expect(() =>
      parseMessage(schema, {
        content: [{ type: "text", text: '{"a":"x"}' }],
        stop_reason: "end_turn",
      }),
    ).toThrow();
  });
});

describe("matchRequirements", () => {
  it("uses Haiku and drops matches the profile can't back up", async () => {
    const llm = new FakeLlm({
      requirements: () => ({
        required: ["Python", "Kubernetes", "SQL"],
        // The model claims Kubernetes; nothing in the profile mentions it.
        matched: ["Python", "Kubernetes", "SQL", "Rust"],
      }),
    });
    const m = await matchRequirements(llm, makePosting(), testProfile());
    expect(llm.requests[0]!.model).toBe(MODELS.haiku);
    expect(m).toEqual({
      required: ["Python", "Kubernetes", "SQL"],
      matched: ["Python", "SQL"],
      missing: ["Kubernetes"],
      method: "model",
    });
    for (const v of sensitiveValues(testProfile())) {
      expect(llm.requests[0]!.system + llm.requests[0]!.user).not.toContain(v);
    }
  });
});
