import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const yearMonth = z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, "use YYYY-MM");
const factId = z.string().regex(/^[a-z0-9_.-]+$/i, "fact ids use letters, digits, '.', '_' or '-'");

export const FactSchema = z.object({
  id: factId,
  text: z.string().min(1),
  tools: z.array(z.string()).default([]),
  /** A number may appear in generated text only if it is written here, exactly. */
  verified_metric: z.string().nullable().default(null),
});

const EntrySchema = z.object({
  id: factId,
  facts: z.array(FactSchema).default([]),
  /** false: kept off your default resume, but tailoring may still pick it for a posting. */
  on_base_resume: z.boolean().default(true),
});

export const ExperienceSchema = EntrySchema.extend({
  org: z.string(),
  title: z.string(),
  start: yearMonth,
  end: z.union([yearMonth, z.literal("present")]),
});

export const ProjectSchema = EntrySchema.extend({ name: z.string() });

export const SkillLevel = z.enum(["project", "coursework", "familiar"]);
export type SkillLevel = z.infer<typeof SkillLevel>;

export const ROLE_FAMILIES = ["swe", "data_ml", "pm", "quant", "hardware", "other"] as const;
export const RoleFamily = z.enum(ROLE_FAMILIES);
export type RoleFamily = z.infer<typeof RoleFamily>;

export const WatchlistEntry = z.object({
  company: z.string(),
  ats: z.enum(["greenhouse", "lever", "ashby"]),
  token: z.string(),
});
export type WatchlistEntry = z.infer<typeof WatchlistEntry>;

const EeoChoice = z.string().default("decline");

export const ProfileSchema = z.object({
  identity: z.object({
    name: z.string(),
    email: z.string(),
    phone: z.string().nullable().default(null),
    city: z.string().nullable().default(null),
    links: z.record(z.string(), z.string().nullable()).default({}),
  }),
  education: z
    .array(
      z.object({
        id: factId,
        school: z.string(),
        degree: z.string(),
        major: z.string(),
        grad: yearMonth,
        gpa: z.union([z.string(), z.number()]).nullable().default(null),
        courses: z.array(z.string()).default([]),
      }),
    )
    .min(1),
  experience: z.array(ExperienceSchema).default([]),
  projects: z.array(ProjectSchema).default([]),
  skills: z.array(z.object({ name: z.string(), level: SkillLevel })).default([]),
  work_authorization: z.object({
    authorized_us: z.boolean(),
    needs_sponsorship_now: z.boolean(),
    needs_sponsorship_later: z.boolean(),
    us_citizen: z.boolean().default(false),
  }),
  eeo: z
    .object({
      gender: EeoChoice,
      race_ethnicity: EeoChoice,
      veteran: EeoChoice,
      disability: EeoChoice,
    })
    .default({
      gender: "decline",
      race_ethnicity: "decline",
      veteran: "decline",
      disability: "decline",
    }),
  logistics: z
    .object({
      earliest_start: yearMonth.nullable().default(null),
      relocation: z.boolean().default(true),
      /** Your honest answer to "How did you hear about us?" */
      how_heard: z.string().default("Online job board"),
    })
    .default({ earliest_start: null, relocation: true, how_heard: "Online job board" }),
  answer_bank: z
    .array(z.object({ id: factId, prompt: z.string(), answer: z.string() }))
    .default([]),
  style: z
    .object({
      voice: z.string().default("plain, specific, no buzzwords"),
      cover_letter_words: z.tuple([z.number(), z.number()]).default([250, 350]),
    })
    .default({ voice: "plain, specific, no buzzwords", cover_letter_words: [250, 350] }),
  preferences: z
    .object({
      terms: z.array(z.string()).default(["Summer 2027"]),
      role_families: z.array(RoleFamily).default(["swe"]),
      /** Ranked. Matched case-insensitively as substrings of a posting's locations. */
      locations: z.array(z.string()).default([]),
      /** false: locations only rank postings; nothing is dropped for being elsewhere. */
      strict_locations: z.boolean().default(true),
      allow_remote: z.boolean().default(true),
      include_coops: z.boolean().default(false),
      degree_level: z.enum(["associates", "bachelors", "masters", "phd"]).default("bachelors"),
      target_companies: z.array(z.string()).default([]),
      watchlist: z.array(WatchlistEntry).default([]),
      per_company_cap: z.number().int().min(1).default(3),
      tier_thresholds: z
        .object({ a: z.number().default(80), b: z.number().default(60) })
        .default({ a: 80, b: 60 }),
    })
    .default({
      terms: ["Summer 2027"],
      role_families: ["swe"],
      locations: [],
      strict_locations: true,
      allow_remote: true,
      include_coops: false,
      degree_level: "bachelors",
      target_companies: [],
      watchlist: [],
      per_company_cap: 3,
      tier_thresholds: { a: 80, b: 60 },
    }),
});

export type Profile = z.infer<typeof ProfileSchema>;
export type Fact = z.infer<typeof FactSchema>;
export type Preferences = Profile["preferences"];

export interface IndexedFact {
  id: string;
  text: string;
  tools: string[];
  verifiedMetric: string | null;
  /** Where it came from, for display: "Undergraduate researcher, University research lab". */
  origin: string;
}

/** Every citable fact in the profile, keyed by id. */
export function indexFacts(profile: Profile): Map<string, IndexedFact> {
  const out = new Map<string, IndexedFact>();
  const add = (f: IndexedFact) => {
    if (out.has(f.id)) throw new Error(`Duplicate fact id in profile: ${f.id}`);
    out.set(f.id, f);
  };
  for (const e of profile.education) {
    add({
      id: e.id,
      text: `${e.degree} in ${e.major}, ${e.school}, expected ${e.grad}`,
      tools: [],
      verifiedMetric: null,
      origin: e.school,
    });
  }
  for (const x of profile.experience) {
    for (const f of x.facts) {
      add({
        id: f.id,
        text: f.text,
        tools: f.tools,
        verifiedMetric: f.verified_metric,
        origin: `${x.title}, ${x.org}`,
      });
    }
  }
  for (const p of profile.projects) {
    for (const f of p.facts) {
      add({
        id: f.id,
        text: f.text,
        tools: f.tools,
        verifiedMetric: f.verified_metric,
        origin: p.name,
      });
    }
  }
  for (const a of profile.answer_bank) {
    add({
      id: a.id,
      text: a.answer,
      tools: [],
      verifiedMetric: null,
      origin: `Answer bank: ${a.prompt}`,
    });
  }
  return out;
}

export function parseProfile(yamlText: string): Profile {
  const raw: unknown = parse(yamlText);
  const result = ProfileSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`profile.yaml is invalid:\n${issues}`);
  }
  indexFacts(result.data); // throws on duplicate ids
  return result.data;
}

export function loadProfile(path: string): Profile {
  return parseProfile(readFileSync(path, "utf8"));
}

/** The profile's skills, lower-cased, for matching. */
export function skillNames(profile: Profile): Set<string> {
  return new Set(profile.skills.map((s) => s.name.toLowerCase()));
}

export function primaryEducation(profile: Profile) {
  const e = profile.education[0];
  if (!e) throw new Error("profile.yaml needs at least one education entry");
  return e;
}
