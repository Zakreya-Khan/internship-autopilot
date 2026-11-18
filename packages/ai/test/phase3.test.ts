import { describe, expect, it } from "vitest";
import { FakeLlm, mapFieldsWithModel, MODELS } from "../src/index.ts";

describe("mapFieldsWithModel", () => {
  it("keeps only valid, one-to-one matches and never sees values", async () => {
    const llm = new FakeLlm({
      map_fields: () => ({
        matches: [
          { page_key: "ia-6", plan_key: "q_why" },
          { page_key: "ia-7", plan_key: "q_why" }, // same plan entry twice: second dropped
          { page_key: "ia-8", plan_key: "made_up" }, // unknown plan key
          { page_key: "ia-99", plan_key: "q_start" }, // unknown page key
          { page_key: "ia-9", plan_key: null },
        ],
      }),
    });
    const out = await mapFieldsWithModel(
      llm,
      ["ia-6", "ia-7", "ia-8", "ia-9"].map((key) => ({
        key,
        label: key,
        type: "text" as const,
        required: false,
      })),
      [
        { key: "q_why", label: "Why us?" },
        { key: "q_start", label: "Start date?" },
      ],
    );
    expect([...out]).toEqual([["ia-6", "q_why"]]);
    expect(llm.requests[0]).toMatchObject({ model: MODELS.haiku, purpose: "map_fields" });
  });
});
