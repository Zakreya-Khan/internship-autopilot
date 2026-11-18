import { decodeEntities } from "@ia/core";
import type { FormQuestion, QuestionType } from "@ia/core";
import type { GetJsonOptions } from "./http.ts";
import { getText, HttpError } from "./http.ts";

/**
 * Lever's application page is server-rendered HTML, so the questions can be read without a
 * browser: the standard fields have fixed names, each custom question card (and each voluntary
 * survey) carries its questions as JSON in a hidden `...[baseTemplate]` input, and the EEO
 * block is native selects or radios named `eeo[...]`. Lever's robots.txt allows ordinary
 * visitors to this page; requests go through the shared per-host limiter.
 *
 * Question keys are the inputs' own `name` attributes, which is how the Lever adapter finds
 * a field on the live page.
 */

const STANDARD_LABELS: Record<string, { label: string; type: QuestionType }> = {
  resume: { label: "Resume/CV", type: "file" },
  name: { label: "Full name", type: "text" },
  email: { label: "Email", type: "text" },
  phone: { label: "Phone", type: "text" },
  location: { label: "Current location", type: "text" },
  org: { label: "Current company", type: "text" },
  comments: { label: "Additional information", type: "textarea" },
};

/** The voluntary EEO inputs worth listing. The disability form's signature and date are skipped. */
const EEO_LABELS: Record<string, string> = {
  "eeo[gender]": "Gender",
  "eeo[race]": "Race",
  "eeo[veteran]": "Veteran status",
  "eeo[disability]": "Disability status",
};

const CARD_TYPES: Record<string, QuestionType> = {
  text: "text",
  textarea: "textarea",
  "multiple-choice": "radio",
  "multiple-select": "multi_select",
  dropdown: "select",
};

export function leverApplyUrl(token: string, jobId: string, eu = false): string {
  const host = eu ? "jobs.eu.lever.co" : "jobs.lever.co";
  return `https://${host}/${encodeURIComponent(token)}/${encodeURIComponent(jobId)}/apply`;
}

interface Control {
  tag: "input" | "select" | "textarea";
  attrs: Record<string, string>;
  /** Option labels for a select. */
  options: string[];
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    out[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

function collectControls(html: string): Control[] {
  const controls: Control[] = [];
  // Attribute values may hold a ">" (the hidden JSON inputs), so quoted strings are skipped whole.
  const attrText = `((?:"[^"]*"|'[^']*'|[^>"'])*)`;
  const tag = new RegExp(
    `<(input|textarea|select)\\b${attrText}>|<option\\b${attrText}>([^<]*)|</select>`,
    "gi",
  );
  let open: Control | null = null;
  for (const m of html.matchAll(tag)) {
    const whole = m[0].toLowerCase();
    if (whole.startsWith("</select")) {
      open = null;
    } else if (whole.startsWith("<option")) {
      const text = decodeEntities(m[4] ?? "").trim();
      if (open && text && !/^select\b/i.test(text)) open.options.push(text);
    } else {
      const c: Control = {
        tag: m[1]!.toLowerCase() as Control["tag"],
        attrs: parseAttrs(m[2] ?? ""),
        options: [],
      };
      controls.push(c);
      open = c.tag === "select" ? c : null;
    }
  }
  return controls;
}

interface CardField {
  type?: string;
  text?: string;
  required?: boolean;
  options?: { text?: string }[];
}

function cardQuestions(
  group: string,
  id: string,
  template: { type?: string; fields?: CardField[] },
): FormQuestion[] {
  const out: FormQuestion[] = [];
  (template.fields ?? []).forEach((f, i) => {
    const label = (f.text ?? "").trim();
    if (!label) return;
    const key =
      group === "cards" ? `cards[${id}][field${i}]` : `${group}[${id}][responses][field${i}]`;
    const options = (f.options ?? []).map((o) => (o.text ?? "").trim()).filter(Boolean);
    out.push({
      key,
      label,
      required: Boolean(f.required),
      type: CARD_TYPES[f.type ?? ""] ?? "text",
      ...(options.length ? { options } : {}),
    });
  });
  return out;
}

function urlLabel(name: string): string {
  const inner = /^urls\[(.*)\]$/.exec(name)?.[1]?.trim() ?? name;
  if (/^linkedin$/i.test(inner)) return "LinkedIn URL";
  if (/^github$/i.test(inner)) return "GitHub URL";
  if (/^portfolio$/i.test(inner)) return "Portfolio URL";
  return /url|link|site/i.test(inner) ? inner : `${inner} URL`;
}

/**
 * The questions on a Lever application page, in page order: standard fields, custom question
 * cards, the voluntary EEO block, then voluntary surveys. An empty list means the page has no
 * application form (a closed posting, or a page that isn't Lever's).
 */
export function parseLeverApplyPage(html: string): FormQuestion[] {
  if (!/<form\b[^>]*\bid\s*=\s*["']application-form["']/i.test(html)) return [];
  const controls = collectControls(html);
  const named = controls.filter((c) => c.attrs.name);
  const byName = new Map<string, Control[]>();
  for (const c of named) byName.set(c.attrs.name!, [...(byName.get(c.attrs.name!) ?? []), c]);
  const requiredNames = new Set(
    named.filter((c) => "required" in c.attrs).map((c) => c.attrs.name!),
  );

  const standard: FormQuestion[] = [];
  for (const [name, def] of Object.entries(STANDARD_LABELS)) {
    if (byName.has(name))
      standard.push({
        key: name,
        label: def.label,
        // Lever always asks for a resume, though its input isn't marked required in the HTML.
        required: name === "resume" || requiredNames.has(name),
        type: def.type,
      });
  }
  // Lever's own URL inputs, after the contact fields, as they appear on the page.
  const urls: FormQuestion[] = [...byName.keys()]
    .filter((n) => /^urls\[.+\]$/.test(n))
    .map((n) => ({
      key: n,
      label: urlLabel(n),
      required: requiredNames.has(n),
      type: "text" as const,
    }));
  const at = standard.findIndex((q) => q.key === "comments");
  if (at >= 0) standard.splice(at, 0, ...urls);
  else standard.push(...urls);

  const cards: FormQuestion[] = [];
  const surveys: FormQuestion[] = [];
  for (const c of named) {
    const m = /^(cards|surveysResponses)\[([^\]]+)\]\[baseTemplate\]$/.exec(c.attrs.name!);
    if (!m || c.attrs.type !== "hidden") continue;
    let template: { type?: string; fields?: CardField[] };
    try {
      template = JSON.parse(c.attrs.value ?? "{}") as typeof template;
    } catch {
      continue;
    }
    const survey = m[1] === "surveysResponses" || template.type === "survey";
    (survey ? surveys : cards).push(...cardQuestions(m[1]!, m[2]!, template));
  }

  const eeo: FormQuestion[] = [];
  for (const [name, label] of Object.entries(EEO_LABELS)) {
    const group = byName.get(name);
    if (!group) continue;
    const select = group.find((g) => g.tag === "select");
    const options = select
      ? select.options
      : group.map((g) => g.attrs.value ?? "").filter((v) => v);
    eeo.push({
      key: name,
      label,
      required: false,
      type: select ? "select" : "radio",
      ...(options.length ? { options } : {}),
    });
  }
  return [...standard, ...cards, ...eeo, ...surveys];
}

/**
 * The application form for one Lever posting, before any browser opens. A posting that has
 * been taken down (404/410) gives an empty list; anything else that goes wrong throws, so the
 * caller can try again on a later run.
 */
export async function fetchLeverQuestions(
  token: string,
  jobId: string,
  opts: GetJsonOptions,
  eu = false,
): Promise<FormQuestion[]> {
  try {
    return parseLeverApplyPage(await getText(leverApplyUrl(token, jobId, eu), opts));
  } catch (e) {
    if (e instanceof HttpError && (e.status === 404 || e.status === 410)) return [];
    throw e;
  }
}
