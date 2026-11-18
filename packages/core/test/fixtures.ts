// Fictional test data only. Nothing here describes a real person.
import { parseProfile } from "../src/profile.ts";
import type { Profile } from "../src/profile.ts";
import type { Posting } from "../src/types.ts";

export const TEST_PROFILE_YAML = `
identity:
  name: "Alex Example"
  email: "alex@example.com"
  phone: "+1 555 0100"
  city: "Berkeley, CA"
  links:
    linkedin: "https://www.linkedin.com/in/example"
    github: "https://github.com/example"
education:
  - id: edu.main
    school: "Example University"
    degree: "B.S."
    major: "Computer Science"
    grad: 2028-05
    gpa: "3.70"
    courses: [data-structures, databases]
experience:
  - id: exp.lab
    org: "University research lab"
    title: "Undergraduate researcher"
    start: 2026-01
    end: present
    facts:
      - id: exp.lab.f1
        text: "Built a Python pipeline that cleaned three years of sensor data"
        tools: [python, pandas]
        verified_metric: null
      - id: exp.lab.f2
        text: "Cut the nightly processing job from 6 hours to 40 minutes"
        tools: [python]
        verified_metric: "6 hours to 40 minutes"
projects:
  - id: proj.app
    name: "Course scheduler"
    facts:
      - id: proj.app.f1
        text: "Wrote a web app that builds conflict-free class schedules"
        tools: [typescript, react]
        verified_metric: null
skills:
  - { name: python, level: project }
  - { name: typescript, level: project }
  - { name: react, level: project }
  - { name: sql, level: coursework }
  - { name: go, level: familiar }
work_authorization:
  authorized_us: true
  needs_sponsorship_now: false
  needs_sponsorship_later: false
  us_citizen: false
eeo:
  gender: decline
  race_ethnicity: decline
  veteran: "I am not a protected veteran"
  disability: decline
logistics:
  earliest_start: 2027-05
  relocation: true
answer_bank:
  - id: ans.why_field
    prompt: "Why are you interested in software engineering?"
    answer: "I like turning messy real-world data into tools people use every day."
  - id: ans.challenge
    prompt: "Describe a technical challenge you solved."
    answer: "Our lab's nightly job took 6 hours. I profiled it, found repeated file reads, and cached them."
preferences:
  terms: ["Summer 2027"]
  role_families: [swe, data_ml]
  locations: ["San Francisco", "Seattle", "New York"]
  allow_remote: true
  degree_level: bachelors
  target_companies: ["Dream Corp"]
  watchlist:
    - { company: "Example Co", ats: greenhouse, token: exampleco }
`;

export function testProfile(overrides: (p: Profile) => Profile = (p) => p): Profile {
  return overrides(parseProfile(TEST_PROFILE_YAML));
}

let counter = 0;

export function makePosting(partial: Partial<Posting> = {}): Posting {
  counter++;
  const now = partial.firstSeen ?? "2026-11-15T00:00:00.000Z";
  return {
    id: `greenhouse:exampleco:${1000 + counter}`,
    company: "Example Co",
    title: "Software Engineering Intern, Summer 2027",
    locations: ["San Francisco, CA"],
    ats: "greenhouse",
    boardToken: "exampleco",
    atsJobId: String(1000 + counter),
    applyUrl: `https://job-boards.greenhouse.io/exampleco/jobs/${1000 + counter}`,
    sourceLinks: [],
    sources: ["greenhouse"],
    descriptionText:
      "We are looking for interns who know Python and TypeScript. Experience with React and SQL is a plus.",
    terms: ["Summer 2027"],
    category: "Software",
    roleFamily: "swe",
    degrees: ["Bachelor's"],
    sponsorship: "unknown",
    deadline: null,
    postedAt: null,
    firstSeen: now,
    lastSeen: now,
    isOpen: true,
    missedPolls: 0,
    questions: null,
    ...partial,
  };
}
