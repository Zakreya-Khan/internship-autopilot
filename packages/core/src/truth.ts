import type { IndexedFact, Profile } from "./profile.ts";
import { indexFacts, primaryEducation } from "./profile.ts";
import { sourceOverlap } from "./resume.ts";
import { containsTerm } from "./text.ts";

/** Common technical terms. If one shows up in generated text, the profile must have it. */
export const TECH_TERMS = [
  "python",
  "java",
  "javascript",
  "typescript",
  "c++",
  "c#",
  "go",
  "golang",
  "rust",
  "kotlin",
  "swift",
  "scala",
  "ruby",
  "php",
  "r",
  "matlab",
  "julia",
  "haskell",
  "elixir",
  "perl",
  "bash",
  "sql",
  "nosql",
  "react",
  "angular",
  "vue",
  "svelte",
  "next.js",
  "node.js",
  "express",
  "django",
  "flask",
  "fastapi",
  "spring",
  "rails",
  ".net",
  "graphql",
  "rest",
  "grpc",
  "kafka",
  "spark",
  "hadoop",
  "airflow",
  "dbt",
  "snowflake",
  "bigquery",
  "redshift",
  "postgres",
  "postgresql",
  "mysql",
  "mongodb",
  "redis",
  "cassandra",
  "elasticsearch",
  "dynamodb",
  "sqlite",
  "aws",
  "gcp",
  "azure",
  "docker",
  "kubernetes",
  "terraform",
  "ansible",
  "jenkins",
  "github actions",
  "ci/cd",
  "linux",
  "unix",
  "git",
  "pytorch",
  "tensorflow",
  "keras",
  "jax",
  "scikit-learn",
  "pandas",
  "numpy",
  "opencv",
  "hugging face",
  "llm",
  "langchain",
  "cuda",
  "verilog",
  "vhdl",
  "fpga",
  "embedded c",
  "ros",
  "unity",
  "unreal",
  "figma",
  "tableau",
  "power bi",
  "excel",
  "salesforce",
  "android",
  "ios",
  "flutter",
  "react native",
  "webassembly",
] as const;

const INFLATION =
  /\b(expert|expertise|proficient|proficiency|advanced|fluent|mastery|deep experience|extensive experience|highly skilled)\b/i;

export interface TruthIssue {
  /** What was checked: "bullet:exp.lab", "answer:why_us", "cover_letter". */
  where: string;
  problem: string;
  severity: "block" | "warn";
}

function profileVocabulary(profile: Profile, facts: Map<string, IndexedFact>): string {
  return [
    ...profile.skills.map((s) => s.name),
    ...[...facts.values()].flatMap((f) => [f.text, ...f.tools]),
    ...profile.education.flatMap((e) => [e.major, e.degree, e.school, ...e.courses]),
  ].join("\n");
}

/** Numbers in text, ignoring years and ordinary small counting words. */
function numbersIn(text: string): string[] {
  return (text.match(/\$?\d[\d,.]*\s*(%|percent|x|k|m|\+)?/gi) ?? [])
    .map((n) => n.trim())
    .filter((n) => !/^(19|20)\d\d$/.test(n));
}

export interface ClaimToCheck {
  where: string;
  text: string;
  factIds: string[];
  /** Resume bullets must cite; free-text answers may cite nothing for pure motivation lines. */
  mustCite: boolean;
  /** Text from the posting the answer may legitimately quote (company name, role title). */
  context?: string;
}

/**
 * Code-side truth checks. They cannot be talked out of: citations must exist, numbers must come
 * from verified facts, technologies must be in the profile, and skill levels can't be inflated.
 */
export function checkClaims(profile: Profile, claims: ClaimToCheck[]): TruthIssue[] {
  const facts = indexFacts(profile);
  const vocab = profileVocabulary(profile, facts);
  const levels = new Map(profile.skills.map((s) => [s.name.toLowerCase(), s.level]));
  const gradYear = primaryEducation(profile).grad.slice(0, 4);
  const issues: TruthIssue[] = [];
  for (const c of claims) {
    const unknown = c.factIds.filter((id) => !facts.has(id));
    if (unknown.length)
      issues.push({
        where: c.where,
        problem: `cites unknown fact ids: ${unknown.join(", ")}`,
        severity: "block",
      });
    if (c.mustCite && c.factIds.length === 0)
      issues.push({
        where: c.where,
        problem: "makes a claim without citing a fact",
        severity: "block",
      });

    const cited = c.factIds.map((id) => facts.get(id)).filter((f): f is IndexedFact => Boolean(f));
    const allowedNumbers = [
      ...cited.flatMap((f) => [f.text, f.verifiedMetric ?? ""]),
      c.context ?? "",
      gradYear,
    ].join(" ");
    for (const n of numbersIn(c.text)) {
      const digits = n.replace(/[^\d.]/g, "");
      if (digits && !allowedNumbers.includes(digits)) {
        issues.push({
          where: c.where,
          problem: `number "${n}" isn't in the cited facts`,
          severity: "block",
        });
      }
    }
    for (const term of TECH_TERMS) {
      if (term.length <= 1) continue; // "r" alone is too ambiguous to police
      if (
        containsTerm(c.text, term) &&
        !containsTerm(vocab, term) &&
        !(c.context && containsTerm(c.context, term))
      ) {
        issues.push({
          where: c.where,
          problem: `mentions ${term}, which isn't in your profile`,
          severity: "block",
        });
      }
    }
    if (INFLATION.test(c.text)) {
      for (const [skill, level] of levels) {
        if (level !== "project" && containsTerm(c.text, skill)) {
          issues.push({
            where: c.where,
            problem: `describes ${skill} too strongly; your level is "${level}"`,
            severity: "block",
          });
        }
      }
    }
    if (
      cited.length &&
      sourceOverlap(
        c.text,
        cited.map((f) => f.text),
      ) < 0.35
    ) {
      issues.push({
        where: c.where,
        problem: "wording drifted far from its source fact; read it first",
        severity: "warn",
      });
    }
  }
  return issues;
}
