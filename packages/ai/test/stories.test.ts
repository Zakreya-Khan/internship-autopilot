import { checkStory, storiesFromFacts, storiesMarkdown, storyNumbers } from "@ia/core";
import type { StarStory } from "@ia/core";
import { testProfile } from "@ia/core/testing";
import { describe, expect, it } from "vitest";
import { draftStories, FakeLlm, sensitiveValues } from "../src/index.ts";

const profile = testProfile();

const story = (over: Partial<StarStory> = {}): StarStory => ({
  title: "Speeding up the nightly job",
  situation: "Our lab's nightly processing job was slow.",
  task: "I wanted results ready by morning.",
  action: "I profiled it and cached repeated file reads.",
  result: "It went from 6 hours to 40 minutes.",
  bestFor: ["a hard problem"],
  factIds: ["exp.lab.f2"],
  ...over,
});

describe("storyNumbers", () => {
  it("canonicalizes separators, k/M and spelled numbers", () => {
    expect(storyNumbers("12,500 rows, 3k users, 2M events, three years")).toEqual([
      "12500",
      "3000",
      "2000000",
      "3",
    ]);
  });
});

describe("checkStory", () => {
  it("passes a story whose numbers come from its cited fact", () => {
    expect(checkStory(profile, story())).toEqual([]);
  });

  it("flags a number that isn't in the cited facts", () => {
    const issues = checkStory(
      profile,
      story({ result: "It went from 6 hours to 40 minutes, saving $5,000." }),
    );
    expect(issues.map((i) => i.problem)).toContain("the number 5000 isn't in the facts it cites");
  });

  it("flags a number taken from a fact the story doesn't cite", () => {
    const issues = checkStory(profile, story({ factIds: ["exp.lab.f1"] }));
    expect(issues.map((i) => i.problem)).toEqual(
      expect.arrayContaining(["the number 6 isn't in the facts it cites"]),
    );
  });

  it("flags unknown facts, missing actions and writing-rule breaks", () => {
    const issues = checkStory(
      profile,
      story({ factIds: ["nope"], action: "", result: "I leveraged caching." }),
    ).map((i) => i.problem);
    expect(issues).toEqual(
      expect.arrayContaining([
        "cites unknown facts: nope",
        "cites no facts",
        "has no action",
        expect.stringContaining("leveraged"),
      ]),
    );
  });

  it("ignores years", () => {
    expect(checkStory(profile, story({ situation: "In 2026 our lab's job was slow." }))).toEqual(
      [],
    );
  });
});

describe("offline stories", () => {
  it("uses only your own fact wording and passes its own check", () => {
    const stories = storiesFromFacts(profile);
    expect(stories.length).toBeGreaterThan(0);
    expect(stories[0]!.result).toBe("Cut the nightly processing job from 6 hours to 40 minutes");
    for (const s of stories) expect(checkStory(profile, s)).toEqual([]);
    expect(storiesMarkdown(stories, [])).toContain("**A (Action):**");
  });
});

describe("draftStories", () => {
  it("sends only the model view of the profile and maps the result", async () => {
    const llm = new FakeLlm({
      stories: () => ({
        stories: [
          {
            title: "Speeding up the nightly job",
            situation: "s",
            task: "t",
            action: "I cached repeated reads.",
            result: "6 hours to 40 minutes.",
            best_for: ["a hard problem"],
            fact_ids: ["exp.lab.f2"],
          },
        ],
      }),
    });
    const out = await draftStories(llm, profile, 5);
    expect(out[0]).toMatchObject({ bestFor: ["a hard problem"], factIds: ["exp.lab.f2"] });
    const req = llm.requests[0]!;
    for (const v of sensitiveValues(profile)) expect(`${req.system}\n${req.user}`).not.toContain(v);
    expect(req.user).toContain("5 stories");
    const md = storiesMarkdown(out, [{ story: out[0]!.title, problem: "check me" }]);
    expect(md).toContain("**Check before using:** check me");
  });
});

describe("draftOutreach", () => {
  it("asks for three sentences under the cap, and never sends sensitive values", async () => {
    const { draftOutreach } = await import("../src/index.ts");
    const { makePosting } = await import("@ia/core/testing");
    const llm = new FakeLlm({
      outreach: () => ({
        message: "  I'm applying for the intern role. ",
        fact_ids: ["exp.lab.f1"],
      }),
    });
    const r = await draftOutreach(llm, profile, makePosting(), "referral");
    expect(r).toEqual({ message: "I'm applying for the intern role.", factIds: ["exp.lab.f1"] });
    const req = llm.requests[0]!;
    expect(req.system).toContain("Exactly three sentences, at most 300 characters");
    expect(req.system).toContain("[how you know them]");
    for (const v of sensitiveValues(profile)) expect(`${req.system}\n${req.user}`).not.toContain(v);
  });
});
