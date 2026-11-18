import { indexFacts, primaryEducation } from "@ia/core";
import type { Profile } from "@ia/core";

/**
 * The only view of the profile the model ever sees: skills, education and citable facts.
 * Contact details, EEO answers, work authorization and GPA are deliberately left out.
 */
export function profileForModel(profile: Profile): string {
  const edu = primaryEducation(profile);
  const lines: string[] = [];
  lines.push("<candidate>");
  lines.push(`Education: ${edu.degree} in ${edu.major}, expected graduation ${edu.grad}.`);
  if (edu.courses.length) lines.push(`Relevant courses: ${edu.courses.join(", ")}.`);
  lines.push("Skills (name: level; never claim a higher level than listed):");
  for (const s of profile.skills) lines.push(`- ${s.name}: ${s.level}`);
  lines.push("Facts (cite by id; nothing outside this list may be claimed):");
  for (const f of indexFacts(profile).values()) {
    const tools = f.tools.length ? ` [tools: ${f.tools.join(", ")}]` : "";
    const metric = f.verifiedMetric ? ` [verified number: "${f.verifiedMetric}"]` : "";
    lines.push(`- ${f.id} (${f.origin}): ${f.text}${tools}${metric}`);
  }
  lines.push("</candidate>");
  return lines.join("\n");
}

/** Everything in the profile that must never appear in a model request. */
export function sensitiveValues(profile: Profile): string[] {
  const vals = [
    profile.identity.email,
    profile.identity.phone,
    ...Object.values(profile.eeo),
    String(primaryEducation(profile).gpa ?? ""),
  ];
  return vals.filter((v): v is string => typeof v === "string" && v.length > 3 && v !== "decline");
}
