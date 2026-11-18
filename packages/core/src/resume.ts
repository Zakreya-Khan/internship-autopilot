import { diffWords } from "diff";
import type { Profile } from "./profile.ts";
import { indexFacts } from "./profile.ts";

export interface ResumeBullet {
  text: string;
  /** Profile fact ids this bullet rests on. Never empty. */
  factIds: string[];
}

export interface ResumeEntry {
  /** Experience or project id from the profile. */
  id: string;
  heading: string;
  subheading: string;
  dates: string;
  bullets: ResumeBullet[];
}

export interface ResumeDoc {
  header: {
    name: string;
    email: string;
    phone: string | null;
    city: string | null;
    links: string[];
  };
  education: {
    school: string;
    degree: string;
    major: string;
    grad: string;
    gpa: string | null;
    courses: string[];
  }[];
  experience: ResumeEntry[];
  projects: ResumeEntry[];
  skills: string[];
}

/** What the model returns for a tailored resume: selection, order and wording, all citing facts. */
export interface ResumePlan {
  entries: { entryId: string; bullets: ResumeBullet[] }[];
  skillsOrder: string[];
  courses: string[];
}

function fmtYm(ym: string): string {
  if (ym === "present") return "Present";
  const [y, m] = ym.split("-");
  const names = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${names.at(Number(m) - 1) ?? ""} ${y}`.trim();
}

/** The base resume: every fact, in profile order. Variants are measured against this. */
export function buildBaseResume(profile: Profile, opts: { includeGpa?: boolean } = {}): ResumeDoc {
  const links = Object.values(profile.identity.links).filter((l): l is string => Boolean(l));
  return {
    header: {
      name: profile.identity.name,
      email: profile.identity.email,
      phone: profile.identity.phone,
      city: profile.identity.city,
      links,
    },
    education: profile.education.map((e) => ({
      school: e.school,
      degree: e.degree,
      major: e.major,
      grad: fmtYm(e.grad),
      gpa: opts.includeGpa !== false && e.gpa != null ? String(e.gpa) : null,
      courses: e.courses,
    })),
    experience: profile.experience.map((x) => ({
      id: x.id,
      heading: x.title,
      subheading: x.org,
      dates: `${fmtYm(x.start)} – ${fmtYm(x.end)}`,
      bullets: x.facts.map((f) => ({ text: f.text, factIds: [f.id] })),
    })),
    projects: profile.projects.map((p) => ({
      id: p.id,
      heading: p.name,
      subheading: "",
      dates: "",
      bullets: p.facts.map((f) => ({ text: f.text, factIds: [f.id] })),
    })),
    skills: profile.skills.map((s) => s.name),
  };
}

export interface PlanProblem {
  where: string;
  problem: string;
}

/**
 * Apply a plan to the base resume, enforcing the rules in code:
 * a bullet may only cite facts from its own entry; skills and courses may only be
 * reordered or dropped, never added. Violations are returned and the offending part is skipped.
 */
export function applyResumePlan(
  profile: Profile,
  plan: ResumePlan,
): { doc: ResumeDoc; problems: PlanProblem[] } {
  const base = buildBaseResume(profile);
  const problems: PlanProblem[] = [];
  const facts = indexFacts(profile);
  const entryFacts = new Map<string, Set<string>>();
  for (const x of [...profile.experience, ...profile.projects])
    entryFacts.set(x.id, new Set(x.facts.map((f) => f.id)));

  const planned = new Map(plan.entries.map((e) => [e.entryId, e]));
  for (const id of planned.keys()) {
    if (!entryFacts.has(id))
      problems.push({ where: id, problem: "plan names an entry that isn't in your profile" });
  }
  const tailor = (entries: ResumeEntry[]) =>
    entries
      .map((entry) => {
        const p = planned.get(entry.id);
        if (!p) return null; // dropped from this variant
        const own = entryFacts.get(entry.id)!;
        const bullets = p.bullets.filter((b) => {
          if (b.factIds.length === 0) {
            problems.push({ where: entry.id, problem: `bullet cites no fact: "${b.text}"` });
            return false;
          }
          const foreign = b.factIds.filter((f) => !own.has(f) || !facts.has(f));
          if (foreign.length) {
            problems.push({
              where: entry.id,
              problem: `bullet cites facts outside this entry: ${foreign.join(", ")}`,
            });
            return false;
          }
          return true;
        });
        return bullets.length ? { ...entry, bullets } : null;
      })
      .filter((e): e is ResumeEntry => e !== null);

  const known = new Map(profile.skills.map((s) => [s.name.toLowerCase(), s.name]));
  const skills: string[] = [];
  for (const s of plan.skillsOrder) {
    const real = known.get(s.toLowerCase());
    if (!real) problems.push({ where: "skills", problem: `"${s}" is not in your skills` });
    else if (!skills.includes(real)) skills.push(real);
  }
  const allCourses = new Set(profile.education.flatMap((e) => e.courses));
  const courses = plan.courses.filter((c) => {
    if (allCourses.has(c)) return true;
    problems.push({ where: "courses", problem: `"${c}" is not in your courses` });
    return false;
  });

  return {
    doc: {
      ...base,
      education: base.education.map((e, i) =>
        i === 0 ? { ...e, courses: courses.length ? courses : e.courses } : e,
      ),
      experience: tailor(base.experience),
      projects: tailor(base.projects),
      skills: skills.length ? skills : base.skills,
    },
    problems,
  };
}

export type WordChange = { value: string; added?: boolean; removed?: boolean };

export interface BulletDiff {
  status: "kept" | "reworded" | "added" | "removed";
  entryId: string;
  factIds: string[];
  base: string | null;
  variant: string | null;
  /** Word-level changes, for reworded bullets. */
  words: WordChange[] | null;
  /** Position change within its entry: negative = moved up. */
  moved: number;
}

export interface ResumeDiff {
  bullets: BulletDiff[];
  skillsMoved: { skill: string; from: number; to: number }[];
  skillsDropped: string[];
  entriesDropped: string[];
  summary: { kept: number; reworded: number; added: number; removed: number };
}

/** Bullet-level diff between the base resume and a variant, matched by cited fact ids. */
export function diffResume(base: ResumeDoc, variant: ResumeDoc): ResumeDiff {
  const bullets: BulletDiff[] = [];
  const baseEntries = [...base.experience, ...base.projects];
  const varEntries = new Map([...variant.experience, ...variant.projects].map((e) => [e.id, e]));
  const entriesDropped: string[] = [];
  for (const be of baseEntries) {
    const ve = varEntries.get(be.id);
    if (!ve) {
      entriesDropped.push(be.id);
      for (const b of be.bullets) {
        bullets.push({
          status: "removed",
          entryId: be.id,
          factIds: b.factIds,
          base: b.text,
          variant: null,
          words: null,
          moved: 0,
        });
      }
      continue;
    }
    const used = new Set<number>();
    be.bullets.forEach((b, i) => {
      const j = ve.bullets.findIndex(
        (v, k) => !used.has(k) && v.factIds.some((f) => b.factIds.includes(f)),
      );
      if (j < 0) {
        bullets.push({
          status: "removed",
          entryId: be.id,
          factIds: b.factIds,
          base: b.text,
          variant: null,
          words: null,
          moved: 0,
        });
        return;
      }
      used.add(j);
      const v = ve.bullets[j]!;
      const same = v.text.trim() === b.text.trim();
      bullets.push({
        status: same ? "kept" : "reworded",
        entryId: be.id,
        factIds: v.factIds,
        base: b.text,
        variant: v.text,
        words: same
          ? null
          : diffWords(b.text, v.text).map((c) => ({
              value: c.value,
              ...(c.added ? { added: true } : {}),
              ...(c.removed ? { removed: true } : {}),
            })),
        moved: j - i,
      });
    });
    ve.bullets.forEach((v, k) => {
      if (!used.has(k)) {
        bullets.push({
          status: "added",
          entryId: be.id,
          factIds: v.factIds,
          base: null,
          variant: v.text,
          words: null,
          moved: 0,
        });
      }
    });
  }
  const skillsMoved = variant.skills
    .map((s, to) => ({ skill: s, from: base.skills.indexOf(s), to }))
    .filter((m) => m.from >= 0 && m.from !== m.to);
  const count = (s: BulletDiff["status"]) => bullets.filter((b) => b.status === s).length;
  return {
    bullets,
    skillsMoved,
    skillsDropped: base.skills.filter((s) => !variant.skills.includes(s)),
    entriesDropped,
    summary: {
      kept: count("kept"),
      reworded: count("reworded"),
      added: count("added"),
      removed: count("removed"),
    },
  };
}

/** Word overlap between a bullet and its source facts, 0..1. Low overlap = drifted. */
export function sourceOverlap(text: string, factTexts: string[]): number {
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9+#.]{3,}/g) ?? []);
  const t = words(text);
  if (t.size === 0) return 1;
  const src = words(factTexts.join(" "));
  let hit = 0;
  for (const w of t) if (src.has(w)) hit++;
  return hit / t.size;
}
