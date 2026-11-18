// Your own cover letter as the base for every application. The letter is used word for word;
// the model only writes one short paragraph per posting, and code puts the letter together,
// so nothing you wrote can be reworded.
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { toParagraphs } from "./voice.ts";

export interface CoverLetterBase {
  /** "Hello," or "Dear hiring team,", if the letter opens with one. */
  greeting: string | null;
  /** Body paragraphs, exactly as written (line wraps joined). */
  paragraphs: string[];
  /** "Sincerely," and the like, without your name (the PDF adds it from your profile). */
  closing: string | null;
}

/** The added paragraph's word limit, stated to the model; a draft over the hard cap is left out. */
export const ADDED_PARAGRAPH_WORDS = 70;
export const ADDED_PARAGRAPH_HARD_CAP = 90;

const CLOSING =
  /^(sincerely|best regards|kind regards|warm regards|warmly|regards|best|respectfully|thank you|thanks|cheers|yours truly|yours)\b,?/i;

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

export function wordCount(s: string): number {
  return words(s);
}

export function parseCoverLetterBase(raw: string): CoverLetterBase {
  const paras = toParagraphs(raw);
  let greeting: string | null = null;
  let closing: string | null = null;
  const first = paras[0];
  if (first && words(first) <= 6 && /[,:]$/.test(first)) {
    greeting = first;
    paras.shift();
  }
  const last = paras.at(-1);
  const m = last ? CLOSING.exec(last) : null;
  if (last && m && words(last) <= 8) {
    closing = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1) + ",";
    paras.pop();
  }
  return { greeting, paragraphs: paras, closing };
}

/** Read the letter named in style.cover_letter_base, or null when unset or missing. */
export function readCoverLetterBase(
  path: string | null | undefined,
  profilePath: string,
): CoverLetterBase | null {
  if (!path) return null;
  const full = isAbsolute(path) ? path : resolve(dirname(profilePath), path);
  if (!existsSync(full) || ![".txt", ".md"].includes(extname(full).toLowerCase())) return null;
  const base = parseCoverLetterBase(readFileSync(full, "utf8"));
  return base.paragraphs.length ? base : null;
}

/** Your paragraphs with the posting's paragraph placed before your closing paragraph. */
export function assembleCoverLetter(base: CoverLetterBase, added: string | null): string[] {
  const out = [...base.paragraphs];
  const text = added?.trim();
  if (!text) return out;
  out.splice(out.length > 1 ? out.length - 1 : out.length, 0, text);
  return out;
}

/** The letter as the model sees it: body only, with any email or phone number removed. */
export function coverLetterBaseForModel(base: CoverLetterBase): string {
  return base.paragraphs
    .map((p) =>
      p
        .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]")
        .replace(/\+?\d[\d\s().-]{8,}\d/g, "[phone]"),
    )
    .join("\n\n");
}
