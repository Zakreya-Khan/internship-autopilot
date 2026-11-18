// Your writing voice, as numbers only. Measured from writing samples you point to in
// profile.yaml (style.writing_samples). Only these abstract traits ever leave this module: no
// sentence, phrase or word list from the samples is stored or sent to the model.
// Measures adapted from career-ops (MIT, see NOTICE): writing-profile.mjs.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

export interface VoiceTraits {
  sampleCount: number;
  totalWords: number;
  /** Below ~300 words the numbers are too noisy to steer anything. */
  enough: boolean;
  meanSentenceWords: number;
  longestSentenceWords: number;
  contractionsPer100: number;
  firstPersonPer100: number;
  questionsPer100Sentences: number;
  exclamationsPer100Sentences: number;
  /** Share of sentences that open with And, But or So. */
  conjunctionOpenersPct: number;
  parentheticalsPer100Sentences: number;
  meanParagraphSentences: number;
}

export const MIN_SAMPLE_WORDS = 300;

const WORD = /[\p{L}\p{N}]+(?:['\u2019][\p{L}]+)*/gu;
const CONTRACTION =
  /\b(?:[\p{L}]+n['\u2019]t|[\p{L}]+['\u2019](?:ll|re|ve|d|m)|(?:i|it|that|there|here|he|she|what|let|who|where)['\u2019]s)\b/giu;
const FIRST_PERSON = /\bI(?:['’](?:ll|m|ve|d))?\b/g;
const SENTENCE_SPLIT = /(?<=[.!?]["'”’)]*)\s+(?=[\p{Lu}"'“(\d])/u;

/** Plain paragraphs from a text or Markdown sample: no headings, list markers or markup. */
export function toParagraphs(raw: string): string[] {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/^#{1,6}\s+.*$/gm, "")
    .replace(/(^|\n)\s*(?:[-*]|\d+\.)\s+/g, "$1")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function sentencesOf(paragraph: string): string[] {
  const parts = paragraph.split(SENTENCE_SPLIT).map((s) => s.trim());
  // A lone greeting or sign-off ("Thanks,", "Best") isn't a sentence.
  return parts.filter((s) => /[.!?]["'”’)]*$/.test(s) || (s.match(WORD)?.length ?? 0) >= 5);
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** Measure one or more samples together. */
export function measureVoice(samples: string[]): VoiceTraits {
  let words = 0;
  let sentences = 0;
  let longest = 0;
  let contractions = 0;
  let firstPerson = 0;
  let questions = 0;
  let exclamations = 0;
  let conj = 0;
  let parens = 0;
  let paragraphs = 0;
  for (const raw of samples) {
    for (const p of toParagraphs(raw)) {
      const ss = sentencesOf(p);
      if (!ss.length) continue;
      paragraphs++;
      for (const s of ss) {
        const n = s.match(WORD)?.length ?? 0;
        if (!n) continue;
        sentences++;
        words += n;
        longest = Math.max(longest, n);
        contractions += s.match(CONTRACTION)?.length ?? 0;
        firstPerson += s.match(FIRST_PERSON)?.length ?? 0;
        if (/\?["'”’)]*$/.test(s)) questions++;
        if (/![\s"'”’)]*$/.test(s)) exclamations++;
        if (/^(?:and|but|so)\b/i.test(s)) conj++;
        if (/\([^)]{2,}\)/.test(s)) parens++;
      }
    }
  }
  const per100w = (x: number) => (words ? round1((x / words) * 100) : 0);
  const per100s = (x: number) => (sentences ? round1((x / sentences) * 100) : 0);
  return {
    sampleCount: samples.length,
    totalWords: words,
    enough: words >= MIN_SAMPLE_WORDS,
    meanSentenceWords: sentences ? round1(words / sentences) : 0,
    longestSentenceWords: longest,
    contractionsPer100: per100w(contractions),
    firstPersonPer100: per100w(firstPerson),
    questionsPer100Sentences: per100s(questions),
    exclamationsPer100Sentences: per100s(exclamations),
    conjunctionOpenersPct: per100s(conj),
    parentheticalsPer100Sentences: per100s(parens),
    meanParagraphSentences: paragraphs ? round1(sentences / paragraphs) : 0,
  };
}

/** Read .txt and .md samples from files or folders (one level deep), relative to `baseDir`. */
export function readWritingSamples(paths: string[], baseDir: string): string[] {
  const out: string[] = [];
  const take = (f: string) => {
    if ([".txt", ".md"].includes(extname(f).toLowerCase()) && !/readme\.md$/i.test(f))
      out.push(readFileSync(f, "utf8"));
  };
  for (const p of paths) {
    const full = isAbsolute(p) ? p : resolve(baseDir, p);
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) {
      for (const name of readdirSync(full).sort()) {
        const f = join(full, name);
        if (statSync(f).isFile()) take(f);
      }
    } else take(full);
  }
  return out;
}

/** Traits for a profile's samples, or null when none are set or found. */
export function voiceFromSamples(paths: string[], profilePath: string): VoiceTraits | null {
  if (!paths.length) return null;
  const samples = readWritingSamples(paths, dirname(profilePath));
  if (!samples.length) return null;
  const t = measureVoice(samples);
  return t.totalWords ? t : null;
}

/**
 * Style guidance for cover letters and short answers only. It describes the numbers, never
 * the samples, so nothing you wrote is copied into an application.
 */
export function voicePrompt(t: VoiceTraits | null): string {
  const base = `Voice for cover letters and short answers only (resume bullets stay plain and terse):
- Conversational and direct: "I" and "you", contractions, short paragraphs.
- Sound like a student writing to a person, not a press release. Specific beats impressive.
- Accuracy beats style: never drop or soften a real fact, and never add detail for rhythm.`;
  if (!t || !t.enough) return base;
  const lines = [
    `- Sentences average about ${Math.round(t.meanSentenceWords)} words; keep the longest under about ${Math.max(t.longestSentenceWords, Math.round(t.meanSentenceWords * 2))}.`,
    t.contractionsPer100 >= 1
      ? `- Use contractions often (about ${t.contractionsPer100} per 100 words).`
      : "- Contractions are rare in this voice; use them sparingly.",
    `- First person "I" about ${t.firstPersonPer100} times per 100 words.`,
    t.conjunctionOpenersPct >= 5
      ? `- About ${Math.round(t.conjunctionOpenersPct)}% of sentences start with And, But or So.`
      : null,
    t.parentheticalsPer100Sentences >= 5
      ? "- An occasional parenthetical aside is in character."
      : null,
    t.questionsPer100Sentences >= 5 ? "- An occasional question is in character." : null,
    t.exclamationsPer100Sentences < 2 ? "- No exclamation marks." : null,
    `- Paragraphs of about ${Math.max(1, Math.round(t.meanParagraphSentences))} sentences.`,
  ].filter(Boolean);
  return `${base}
Measured from the candidate's own writing samples (numbers only):
${lines.join("\n")}`;
}

/**
 * A gentle note when a draft runs much longer-winded than your own writing. Advisory only.
 */
export function voiceNotes(t: VoiceTraits | null, text: string): string[] {
  if (!t || !t.enough) return [];
  const m = measureVoice([text]);
  if (m.totalWords < 120) return [];
  const notes: string[] = [];
  if (m.meanSentenceWords > t.meanSentenceWords * 1.4)
    notes.push(
      `sentences average ${m.meanSentenceWords} words; yours average ${t.meanSentenceWords}`,
    );
  if (t.contractionsPer100 >= 1 && m.contractionsPer100 < t.contractionsPer100 * 0.4)
    notes.push("far fewer contractions than you usually use");
  return notes.length ? [`voice: ${notes.join("; ")}`] : [];
}
