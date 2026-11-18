import { buildBaseResume } from "@ia/core";
import { testProfile } from "@ia/core/testing";
import { describe, expect, it } from "vitest";
import {
  extractPdfText,
  pageCount,
  parseCheckResume,
  renderCoverLetterPdf,
  renderResumePdf,
} from "../src/index.ts";

describe("resume PDF", () => {
  const doc = buildBaseResume(testProfile());

  it("renders one page that parses back to text", async () => {
    const pdf = await renderResumePdf(doc);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pageCount(pdf)).toBe(1);
    const check = await parseCheckResume(pdf, doc);
    expect(check).toEqual({ ok: true, pages: 1, missing: [] });
    const text = await extractPdfText(pdf);
    expect(text).toContain("Cut the nightly processing job");
  });

  it("fails the parse check when the PDF lacks the candidate's details", async () => {
    const other = await renderResumePdf({
      ...doc,
      header: { ...doc.header, email: "someone@else.test" },
    });
    const check = await parseCheckResume(other, doc);
    expect(check.ok).toBe(false);
    expect(check.missing).toContain("alex@example.com");
  });

  it("flags a resume that runs past one page", async () => {
    const long = {
      ...doc,
      experience: Array.from({ length: 14 }, (_, i) => ({
        ...doc.experience[0]!,
        id: `x${i}`,
        bullets: Array.from({ length: 4 }, () => doc.experience[0]!.bullets[0]!),
      })),
    };
    const check = await parseCheckResume(await renderResumePdf(long), long);
    expect(check.ok).toBe(false);
    expect(check.missing.at(-1)).toMatch(/fits on one page/);
  });

  it("renders a cover letter", async () => {
    const pdf = await renderCoverLetterPdf("Alex Example", "Example Co", [
      "First paragraph.",
      "Second paragraph.",
    ]);
    expect(await extractPdfText(pdf)).toContain("Dear Example Co hiring team");
  });
});
