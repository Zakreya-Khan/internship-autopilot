import type { ResumeDoc } from "@ia/core";
import { extractText, getDocumentProxy } from "unpdf";
import { pageCount } from "./pdf.ts";

export async function extractPdfText(pdf: Buffer): Promise<string> {
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  const { text } = await extractText(doc, { mergePages: true });
  return text;
}

export interface ParseCheck {
  ok: boolean;
  pages: number;
  missing: string[];
}

/**
 * Many ATSs pre-fill fields from the parsed resume. If the name, email, school or section
 * headings don't come back out of the PDF as text, the variant fails before it reaches you.
 */
export async function parseCheckResume(pdf: Buffer, doc: ResumeDoc): Promise<ParseCheck> {
  const text = (await extractPdfText(pdf)).replace(/\s+/g, " ").toLowerCase();
  const must = [
    doc.header.name,
    doc.header.email,
    ...doc.education.map((e) => e.school),
    "education",
  ];
  if (doc.experience.length) must.push("experience");
  if (doc.skills.length) must.push("skills");
  const missing = must.filter((m) => !text.includes(m.toLowerCase()));
  const pages = pageCount(pdf);
  if (pages > 1) missing.push(`fits on one page (it has ${pages})`);
  return { ok: missing.length === 0, pages, missing };
}
