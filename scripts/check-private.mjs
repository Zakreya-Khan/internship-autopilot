// Fails if anything distinctive from your local profile.yaml appears in a tracked or staged file.
// The repo is public; this catches personal details copied into code, tests or docs by mistake.
// No profile.yaml (e.g. in CI) → nothing to compare against, so it passes.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";

if (!existsSync("profile.yaml")) {
  console.log("check-private: no profile.yaml here, skipped");
  process.exit(0);
}
const p = parse(readFileSync("profile.yaml", "utf8"));
const values = new Set();
const add = (v) => {
  if (typeof v !== "string") return;
  const s = v.trim();
  if (s.length >= 5 && !/^https?:\/\/(www\.)?(github|linkedin)\.com\/?$/.test(s)) values.add(s);
};
add(p.identity?.name);
add(p.identity?.email);
add(p.identity?.phone);
add(p.identity?.phone?.replace(/\D/g, "").slice(-7));
add(p.identity?.city);
for (const l of Object.values(p.identity?.links ?? {})) add(l);
for (const e of p.education ?? []) add(e.school);
for (const x of [...(p.experience ?? []), ...(p.projects ?? [])]) {
  add(x.org);
  for (const f of x.facts ?? []) {
    add(f.text?.slice(0, 40));
    for (const m of String(f.verified_metric ?? "").split(";"))
      if (/\d/.test(m) && m.trim().length >= 4) add(m.trim());
  }
}
for (const a of p.answer_bank ?? []) add(a.answer?.slice(0, 40));

const files = execFileSync("git", ["ls-files", "--cached"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f && f !== "package-lock.json" && existsSync(f));
const hits = [];
for (const f of files) {
  const text = readFileSync(f, "utf8");
  for (const v of values) if (text.includes(v)) hits.push(`${f}: contains "${v}"`);
}
if (hits.length) {
  console.error(
    `check-private: personal details from profile.yaml found in tracked files:\n  ${hits.join("\n  ")}`,
  );
  process.exit(1);
}
console.log(
  `check-private: ${files.length} tracked files clean against ${values.size} profile values`,
);
