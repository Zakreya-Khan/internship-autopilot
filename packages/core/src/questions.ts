import type { Profile } from "./profile.ts";
import { primaryEducation } from "./profile.ts";
import { slug } from "./text.ts";
import type { FormQuestion } from "./types.ts";

/** Fields filled straight from the profile. No model is involved in any of these. */
export const KNOWN_FIELDS = [
  "first_name",
  "last_name",
  "full_name",
  "preferred_name",
  "email",
  "phone",
  "city",
  "linkedin",
  "github",
  "website",
  "school",
  "degree",
  "major",
  "grad_date",
  "grad_year",
  "gpa",
  "resume",
  "cover_letter",
  "authorized_us",
  "needs_sponsorship",
  "us_citizen",
  "eeo_gender",
  "eeo_race",
  "eeo_hispanic",
  "eeo_veteran",
  "eeo_disability",
  "start_date",
  "relocation",
  "how_heard",
  "current_company",
] as const;
export type KnownField = (typeof KNOWN_FIELDS)[number];

/**
 * Who you are and how to reach you. A fill plan holds a copy made at prep time, so these are
 * re-read from the current profile before every fill: change your email and every application
 * not yet submitted uses the new one.
 */
export const CONTACT_FIELDS: ReadonlySet<KnownField> = new Set<KnownField>([
  "first_name",
  "last_name",
  "full_name",
  "preferred_name",
  "email",
  "phone",
  "city",
  "linkedin",
  "github",
  "website",
]);

/** The contact field a question asks for, or null when it asks for something else. */
export function contactFieldOf(q: Pick<FormQuestion, "key" | "label" | "type">): KnownField | null {
  const cls = classifyQuestion(q);
  return cls.kind === "known" && CONTACT_FIELDS.has(cls.field) ? cls.field : null;
}

export type QuestionClass =
  | { kind: "known"; field: KnownField }
  /** Open-ended: drafted from the answer bank and facts, with citations. */
  | { kind: "open" }
  /** A statement only you can make (attestations, consent). Left for you, never ticked. */
  | { kind: "user_only"; reason: string }
  /** Needs a fact the profile doesn't have. */
  | { kind: "needs_you"; reason: string };

const RULES: [RegExp, KnownField][] = [
  [/^(legal )?first[ _-]?name|given name/i, "first_name"],
  [/^(legal )?last[ _-]?name|family name|surname/i, "last_name"],
  [/preferred (first )?name|nickname/i, "preferred_name"],
  [/^((your|full|legal) )*name$|_systemfield_name/i, "full_name"],
  [/^(your |confirm (your )?)?e-?mail( address)?\b|^e-?mail$/i, "email"],
  [/phone|mobile/i, "phone"],
  [/linkedin/i, "linkedin"],
  [/github/i, "github"],
  [/portfolio|website|personal (site|url)|other (website|link)/i, "website"],
  [
    /(current|your) (city|location)|^location( \(city\))?$|^city$|where are you (based|located)/i,
    "city",
  ],
  [/^(school|university|college|institution)( name)?$|which (school|university)/i, "school"],
  [/^degree( type)?$|degree (are you|you are) (pursuing|seeking)/i, "degree"],
  [/major|field of study|discipline/i, "major"],
  [/graduation (year)/i, "grad_year"],
  [/(expected )?graduation( date)?|when (do|will) you graduate/i, "grad_date"],
  [/\bgpa\b|grade point/i, "gpa"],
  [/^resume|^cv\b|resume\/cv/i, "resume"],
  [/^cover letter/i, "cover_letter"],
  [/(require|need).{0,40}sponsor|sponsorship/i, "needs_sponsorship"],
  [/authori[sz]ed to work|legally (able|eligible) to work|work authori[sz]ation/i, "authorized_us"],
  [/u\.?s\.? citizen|citizenship/i, "us_citizen"],
  [/hispanic|latin[oa]/i, "eeo_hispanic"],
  [/gender|sex\b/i, "eeo_gender"],
  [/\brace\b|ethnicity/i, "eeo_race"],
  [/veteran/i, "eeo_veteran"],
  [/disabilit/i, "eeo_disability"],
  [/(earliest |available )?start date|when can you start/i, "start_date"],
  [/relocat/i, "relocation"],
  [
    /how (did )?you (hear|heard|find|found|learn|learned) about|source of (your )?application|referred by a/i,
    "how_heard",
  ],
  [
    /^(current|present|most recent) (company|employer|organi[sz]ation)\b|^candidate['’]?s (current )?(company|employer)$/i,
    "current_company",
  ],
];

/** "If yes, ..." and the like: only needed when an earlier answer calls for it. */
export const FOLLOW_UP_REASON = "a follow-up to an earlier question";
const FOLLOW_UP =
  /^(if (yes|no|so|applicable|other|you (selected|chose|answered|checked|have|are|were|do|did|indicated))\b|if you['’]ve (selected|chosen|answered)\b)/i;

/** Questions about you and this employer. Asked again at every company, on purpose. */
const ABOUT_THIS_EMPLOYER =
  /\bever (been )?(employed|worked)\b|(relatives?|family members?|spouses?|partners?|in-laws?)\b.{0,60}\b(work|employ)/i;

const USER_ONLY: RegExp[] = [
  /receive (communications|messages|texts|updates)|\bsms\b|whatsapp|text messages|opt[- ]?in|marketing/i,
  /certif(y|ication)|attest|acknowledge|i (agree|consent|understand)|privacy (notice|policy)|terms/i,
  /signature|sign(ed)? (here|below)|e-?sign/i,
];

const NEEDS_YOU: RegExp[] = [
  /(know|related to) (anyone|someone)|\breferr(al|ed)\b|employee (name|referral)/i,
  /previously (worked|employed|applied)|former employee|worked (here|for us) before/i,
  /rate your|on a scale|years of (professional )?experience/i,
  /salary|compensation expectation|desired pay/i,
  /non-?compete|security clearance|background check/i,
  /available for .*(weeks?|months?)|internship (length|duration)|full[- ]time (during|this)/i,
];

export function classifyQuestion(q: Pick<FormQuestion, "key" | "label" | "type">): QuestionClass {
  const text = `${q.label}`.trim();
  const key = q.key.toLowerCase();
  if (q.type === "file") {
    if (/cover/i.test(text) || /cover/.test(key)) return { kind: "known", field: "cover_letter" };
    if (/resume|cv/i.test(text) || /resume|cv/.test(key)) return { kind: "known", field: "resume" };
    return { kind: "needs_you", reason: "file upload other than resume or cover letter" };
  }
  // Passwords, PINs and access codes are yours alone. Never planned, whatever else the label says
  // (e.g. "Portfolio, Video, or Website Password").
  if (/pass(word|code|phrase)|\bpin\b|access code/i.test(text) || /password|passcode/.test(key))
    return { kind: "user_only", reason: "a password or access code; enter it yourself if needed" };
  if (FOLLOW_UP.test(text)) return { kind: "user_only", reason: FOLLOW_UP_REASON };
  if (USER_ONLY.some((re) => re.test(text)))
    return { kind: "user_only", reason: "a statement only you can make" };
  if (ABOUT_THIS_EMPLOYER.test(text))
    return {
      kind: "needs_you",
      reason: "it asks about you and this company, so it's asked at every company",
    };
  if (NEEDS_YOU.some((re) => re.test(text)))
    return { kind: "needs_you", reason: "needs a fact your profile doesn't have" };
  for (const [re, field] of RULES) {
    if (re.test(text) || re.test(key.replace(/_/g, " "))) return { kind: "known", field };
  }
  if (
    q.type === "textarea" ||
    (q.type === "text" && /\?|why|describe|tell us|explain|what/i.test(text))
  ) {
    return { kind: "open" };
  }
  return { kind: "needs_you", reason: "not recognized" };
}

/** Learned answers are keyed by the question's wording, so the same question on another form reuses them. */
export function questionKey(label: string): string {
  return slug(label.replace(/\*|\(required\)|\(optional\)/gi, ""), 80);
}

const YES = ["yes", "y", "true"];
const NO = ["no", "n", "false"];
const DECLINE =
  /decline|prefer not|rather not|don['’]?t wish|do not wish|not to (say|disclose|answer)|choose not|not declared|undeclared|not specified/i;

/** Pick the option that best matches what we mean. Returns null rather than guess. */
export function pickOption(options: string[] | undefined, wanted: string | boolean): string | null {
  if (!options || options.length === 0)
    return typeof wanted === "boolean" ? (wanted ? "Yes" : "No") : wanted;
  const opts = options.map((o) => ({ o, l: o.trim().toLowerCase() }));
  if (typeof wanted === "boolean") {
    const words = wanted ? YES : NO;
    const exact = opts.find(({ l }) => words.includes(l));
    if (exact) return exact.o;
    const starts = opts.filter(({ l }) =>
      words.some((w) => l.startsWith(`${w},`) || l.startsWith(`${w} `)),
    );
    return starts.length === 1 ? starts[0]!.o : null;
  }
  const w = wanted.trim().toLowerCase();
  if (w === "decline") return opts.find(({ l }) => DECLINE.test(l))?.o ?? null;
  const exact = opts.find(({ l }) => l === w);
  if (exact) return exact.o;
  const contains = opts.filter(({ l }) => l.includes(w) || w.includes(l));
  return contains.length === 1 ? contains[0]!.o : null;
}

function splitName(full: string): [string, string] {
  const parts = full.trim().split(/\s+/);
  return [parts[0] ?? "", parts.slice(1).join(" ")];
}

function monthYear(ym: string): string {
  const [y, m] = ym.split("-");
  const names = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return `${names.at(Number(m) - 1) ?? ""} ${y}`.trim();
}

/**
 * The profile's value for a known field, shaped for the question (an option label for
 * selects). Null means "can't answer truthfully from the profile".
 */
export function resolveKnownField(
  field: KnownField,
  q: Pick<FormQuestion, "options" | "type">,
  profile: Profile,
): string | null {
  const id = profile.identity;
  const edu = primaryEducation(profile);
  const auth = profile.work_authorization;
  const [first, last] = splitName(id.name);
  const opt = (v: string | boolean) => pickOption(q.options, v);
  switch (field) {
    case "first_name":
    case "preferred_name":
      return first || null;
    case "last_name":
      return last || null;
    case "full_name":
      return id.name;
    case "email":
      return id.email;
    case "phone":
      return id.phone;
    case "city":
      return id.city;
    case "linkedin":
      return id.links.linkedin ?? null;
    case "github":
      return id.links.github ?? null;
    case "website":
      return id.links.portfolio ?? id.links.website ?? id.links.github ?? null;
    case "school":
      return q.options?.length ? opt(edu.school) : edu.school;
    case "degree":
      return q.options?.length ? (opt(edu.degree) ?? opt(degreeWord(edu.degree))) : edu.degree;
    case "major":
      return q.options?.length ? opt(edu.major) : edu.major;
    case "grad_date":
      if (q.type === "date") return `${edu.grad.slice(0, 7)}-01`;
      return q.options?.length ? pickGradOption(q.options, edu.grad) : monthYear(edu.grad);
    case "grad_year":
      return q.options?.length ? opt(edu.grad.slice(0, 4)) : edu.grad.slice(0, 4);
    case "gpa":
      if (edu.gpa == null) return null;
      return q.options?.length ? pickNumericRange(q.options, Number(edu.gpa)) : String(edu.gpa);
    case "resume":
    case "cover_letter":
      return null; // files are attached by the extension, not typed
    case "authorized_us":
      return opt(auth.authorized_us);
    case "needs_sponsorship":
      return opt(auth.needs_sponsorship_now || auth.needs_sponsorship_later);
    case "us_citizen":
      return opt(auth.us_citizen);
    case "eeo_gender":
      return opt(profile.eeo.gender);
    case "eeo_race":
      return opt(profile.eeo.race_ethnicity);
    case "eeo_hispanic":
      return profile.eeo.race_ethnicity === "decline"
        ? opt("decline")
        : opt(/hispanic|latin/i.test(profile.eeo.race_ethnicity));
    case "eeo_veteran":
      return opt(profile.eeo.veteran);
    case "eeo_disability":
      return opt(profile.eeo.disability);
    case "start_date":
      return profile.logistics.earliest_start ? monthYear(profile.logistics.earliest_start) : null;
    case "relocation":
      return opt(profile.logistics.relocation);
    case "current_company": {
      const now = profile.experience.find((x) => x.end === "present");
      return now ? now.org : null;
    }
    case "how_heard":
      return q.options?.length
        ? (opt(profile.logistics.how_heard) ?? opt("job board") ?? opt("other"))
        : profile.logistics.how_heard;
  }
}

function degreeWord(d: string): string {
  if (/^b\.?s|^b\.?a|bachelor/i.test(d)) return "Bachelor";
  if (/^m\.?s|^m\.?a|master/i.test(d)) return "Master";
  if (/ph\.?d|doctor/i.test(d)) return "PhD";
  return d;
}

/** "May 2028", "2028-05", "Spring 2028": the option naming your graduation month or term, if exactly one does. */
export function pickGradOption(options: string[], grad: string): string | null {
  const [y, m] = grad.split("-").map(Number) as [number, number];
  const month =
    [
      "january",
      "february",
      "march",
      "april",
      "may",
      "june",
      "july",
      "august",
      "september",
      "october",
      "november",
      "december",
    ].at(m - 1) ?? "";
  const season = m <= 5 ? "spring" : m <= 8 ? "summer" : m <= 11 ? "fall" : "winter";
  const hits = options.filter((o) => {
    const l = o.toLowerCase();
    if (!l.includes(String(y))) return false;
    return (
      l.includes(month) ||
      l.includes(month.slice(0, 3)) ||
      l.includes(season) ||
      l.includes(`${y}-${String(m).padStart(2, "0")}`) ||
      l.trim() === String(y)
    );
  });
  return hits.length === 1 ? hits[0]! : null;
}

/** "3.75+", "3.41 - 3.74", "Below 3.4": the range that contains the value, if exactly one does. */
export function pickNumericRange(options: string[], value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const direct = numericHit(options, value);
  if (direct !== null) return direct;
  // 3.47 against "3.0-3.4" / "3.5-3.9" falls between buckets: cut it to the options' precision
  // (3.4), never round it up into a higher bucket.
  const places = Math.max(
    0,
    ...options.flatMap((o) => (o.match(/\d+\.(\d+)/g) ?? []).map((n) => n.split(".")[1]!.length)),
  );
  const f = 10 ** places;
  const cut = Math.floor(value * f + 1e-9) / f;
  return cut === value ? null : numericHit(options, cut);
}

function numericHit(options: string[], value: number): string | null {
  const hits = options.filter((o) => {
    const nums = (o.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
    if (nums.length === 0) return false;
    if (/below|under|less than|</i.test(o)) return value < nums[0]!;
    if (/\+|above|or (higher|more)|>/i.test(o) && nums.length === 1) return value >= nums[0]!;
    if (nums.length >= 2) return value >= nums[0]! && value <= nums[1]!;
    return value === nums[0];
  });
  return hits.length === 1 ? hits[0]! : null;
}
