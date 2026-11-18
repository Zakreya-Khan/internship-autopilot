import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assembleCoverLetter,
  buildBaseResume,
  coverLetterBaseForModel,
  orderBaseResume,
  parseCoverLetterBase,
  readCoverLetterBase,
} from "../src/index.ts";
import { testProfile } from "./fixtures.ts";

// Fictional letter, wrapped the way a PDF export or editor wraps lines.
const LETTER = `Hello,

I study computer science and I like building tools that
people actually use.

At the lab I built a Python pipeline that cleaned three
years of sensor data.

I'd welcome the chance to talk. Thank you for reading.

Sincerely, Alex Example
`;

describe("parseCoverLetterBase", () => {
  it("keeps your paragraphs exactly and splits off the greeting and closing", () => {
    const b = parseCoverLetterBase(LETTER);
    expect(b.greeting).toBe("Hello,");
    expect(b.closing).toBe("Sincerely,");
    expect(b.paragraphs).toEqual([
      "I study computer science and I like building tools that people actually use.",
      "At the lab I built a Python pipeline that cleaned three years of sensor data.",
      "I'd welcome the chance to talk. Thank you for reading.",
    ]);
  });

  it("leaves a letter with no greeting or closing whole", () => {
    const b = parseCoverLetterBase("First paragraph here.\n\nSecond one.");
    expect(b).toEqual({
      greeting: null,
      closing: null,
      paragraphs: ["First paragraph here.", "Second one."],
    });
  });
});

describe("assembleCoverLetter", () => {
  const base = parseCoverLetterBase(LETTER);

  it("puts the posting's paragraph before your closing paragraph", () => {
    const out = assembleCoverLetter(base, "At Example Co I'd work on data tools.");
    expect(out).toHaveLength(4);
    expect(out[2]).toBe("At Example Co I'd work on data tools.");
    expect(out.filter((p) => base.paragraphs.includes(p))).toEqual(base.paragraphs);
  });

  it("is your letter alone when there is nothing to add", () => {
    expect(assembleCoverLetter(base, null)).toEqual(base.paragraphs);
    expect(assembleCoverLetter(base, "  ")).toEqual(base.paragraphs);
  });
});

describe("coverLetterBaseForModel", () => {
  it("sends the body only, without contact details or your name", () => {
    const b = parseCoverLetterBase(
      `${LETTER.replace("people actually use.", "people use. Reach me at alex@example.com or (555) 010-0199.")}`,
    );
    const text = coverLetterBaseForModel(b);
    expect(text).not.toContain("alex@example.com");
    expect(text).not.toContain("010-0199");
    expect(text).not.toContain("Alex Example");
    expect(text).not.toContain("Hello,");
  });
});

describe("readCoverLetterBase", () => {
  it("reads a .txt or .md file next to the profile and ignores anything else", () => {
    const dir = mkdtempSync(join(tmpdir(), "ia-cover-"));
    try {
      writeFileSync(join(dir, "letter.txt"), LETTER);
      writeFileSync(join(dir, "letter.pdf"), LETTER);
      const profilePath = join(dir, "profile.yaml");
      expect(readCoverLetterBase("letter.txt", profilePath)?.paragraphs).toHaveLength(3);
      expect(readCoverLetterBase("letter.pdf", profilePath)).toBeNull();
      expect(readCoverLetterBase("missing.txt", profilePath)).toBeNull();
      expect(readCoverLetterBase(null, profilePath)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("orderBaseResume", () => {
  const profile = testProfile();

  it("keeps every bullet word for word and only changes their order and the skills order", () => {
    const base = buildBaseResume(profile);
    const doc = orderBaseResume(profile, {
      entries: [
        {
          entryId: "exp.lab",
          bullets: [
            { text: "Reworded by a model", factIds: ["exp.lab.f2"] },
            { text: "Also reworded", factIds: ["exp.lab.f1"] },
          ],
        },
      ],
      skillsOrder: ["sql", "python", "not-a-skill-of-yours"],
      courses: [],
    });
    const lab = doc.experience.find((e) => e.id === "exp.lab")!;
    expect(lab.bullets.map((b) => b.factIds[0])).toEqual(["exp.lab.f2", "exp.lab.f1"]);
    const texts = (d: typeof doc) =>
      [...d.experience, ...d.projects].flatMap((e) => e.bullets.map((b) => b.text)).sort();
    expect(texts(doc)).toEqual(texts(base));
    expect(doc.skills.slice(0, 2)).toEqual(["sql", "python"]);
    expect([...doc.skills].sort()).toEqual([...base.skills].sort());
    expect(doc.education).toEqual(base.education);
  });
});
