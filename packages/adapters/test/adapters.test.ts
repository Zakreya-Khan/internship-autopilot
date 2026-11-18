// @vitest-environment happy-dom
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ashby,
  clickWizardNext,
  fillForm,
  greenhouse,
  highlightSubmit,
  isSubmitLike,
  lever,
  pickAdapter,
  pressChoice,
  seenMap,
  SubmitGuardError,
} from "../src/index.ts";
import type { FillField } from "../src/index.ts";

// Vitest runs from the repo root; under happy-dom import.meta.url is not a file URL.
const FIXTURES = join(process.cwd(), "fixtures/forms");

let submitted = 0;
function load(name: string) {
  const html = readFileSync(join(FIXTURES, name), "utf8");
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1]!;
  submitted = 0;
  document.addEventListener(
    "submit",
    (e) => {
      submitted++;
      e.preventDefault();
    },
    { capture: true },
  );
}

const f = (
  key: string,
  label: string,
  value: string | null,
  extra: Partial<FillField> = {},
): FillField => ({
  key,
  label,
  type: "text",
  value,
  required: false,
  ...extra,
});

const pdf = () =>
  new File([new Uint8Array([37, 80, 68, 70])], "Alex_Example_Resume.pdf", {
    type: "application/pdf",
  });

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("Greenhouse", () => {
  it("fills text, textarea, select and file fields, skips passwords, and never submits", () => {
    load("greenhouse.html");
    const results = fillForm(
      greenhouse,
      document,
      [
        f("first_name", "First Name", "Alex"),
        f("email", "Email", "alex@example.com"),
        f("resume", "Resume/CV", null, { attach: "resume", type: "file" }),
        f("question_1", "Why do you want to work at Example Co?", "Because of the data tools.", {
          type: "textarea",
        }),
        f("question_2", "Will you require visa sponsorship?", "No", { type: "select" }),
        f("eeo:gender", "Gender", "I don't wish to answer", { type: "select" }),
        f("password_trap", "Create a password", "hunter2"),
        f("privacy", "I acknowledge the privacy notice", null, { type: "checkbox" }),
        f("missing", "A question that isn't on this page", "x"),
      ],
      { resume: pdf() },
    );
    const by = Object.fromEntries(results.map((r) => [r.key, r]));
    expect(by.first_name).toMatchObject({ status: "filled", seen: "Alex" });
    expect(by.resume).toMatchObject({ status: "filled", seen: "Alex_Example_Resume.pdf" });
    expect(by.question_2).toMatchObject({ status: "filled", seen: "No" });
    expect(by["eeo:gender"]).toMatchObject({ status: "filled", seen: "I don't wish to answer" });
    expect(by.password_trap).toMatchObject({
      status: "skipped",
      reason: "password fields are never filled",
    });
    expect((document.getElementById("password_trap") as HTMLInputElement).value).toBe("");
    expect(by.privacy!.status).toBe("skipped");
    expect((document.getElementById("privacy") as HTMLInputElement).checked).toBe(false);
    expect(by.missing!.status).toBe("not_found");
    expect(seenMap(results)).toMatchObject({ first_name: "Alex", question_2: "No" });
    expect(submitted).toBe(0);
  });

  it("outlines the submit button without pressing it", () => {
    load("greenhouse.html");
    const btn = document.getElementById("submit_app")!;
    const clicked = vi.fn();
    btn.addEventListener("click", clicked);
    expect(highlightSubmit(greenhouse, document)).toBe(btn);
    expect(btn.getAttribute("data-ia-highlight")).toBe("submit");
    expect(clicked).not.toHaveBeenCalled();
    expect(submitted).toBe(0);
  });

  it("is picked by URL", () => {
    load("greenhouse.html");
    expect(
      pickAdapter(new URL("https://job-boards.greenhouse.io/exampleco/jobs/1"), document)?.id,
    ).toBe("greenhouse");
  });
});

describe("Lever", () => {
  it("fills by name and ticks a labelled radio group", () => {
    load("lever.html");
    const results = fillForm(
      lever,
      document,
      [
        f("name", "Full name", "Alex Example"),
        f("urls[LinkedIn]", "LinkedIn URL", "https://www.linkedin.com/in/example"),
        f("cards_auth", "Are you legally authorized to work in the United States?", "Yes", {
          type: "radio",
        }),
        f("resume", "Resume/CV", null, { attach: "resume", type: "file" }),
      ],
      { resume: pdf() },
    );
    expect(results.map((r) => r.status)).toEqual(["filled", "filled", "filled", "filled"]);
    const yes = document.querySelector<HTMLInputElement>('input[value="Yes"]')!;
    expect(yes.checked).toBe(true);
    expect(submitted).toBe(0);
  });

  it("recognizes the thank-you page", () => {
    document.body.innerHTML = "<h2>Application submitted!</h2><p>Thanks for applying to Acme.</p>";
    expect(lever.isConfirmation(document, new URL("https://jobs.lever.co/acme/abc/thanks"))).toBe(
      true,
    );
    document.body.innerHTML = "<p>Fill in the form</p>";
    expect(lever.isConfirmation(document, new URL("https://jobs.lever.co/acme/abc/apply"))).toBe(
      false,
    );
  });
});

describe("Ashby", () => {
  it("presses the matching Yes/No choice and nothing else", () => {
    load("ashby.html");
    const pressed: string[] = [];
    document
      .querySelectorAll("button")
      .forEach((b) => b.addEventListener("click", () => pressed.push(b.textContent!)));
    const results = fillForm(
      ashby,
      document,
      [
        f("_systemfield_name", "Name", "Alex Example"),
        f("q_inperson", "Are you able to work in person in New York?", "Yes"),
        f("q_why", "What interests you about this role?", "The data platform.", {
          type: "textarea",
        }),
      ],
      {},
    );
    expect(results.map((r) => r.status)).toEqual(["filled", "filled", "filled"]);
    expect(pressed).toEqual(["Yes"]);
    expect(submitted).toBe(0);
  });
});

describe("the click guard", () => {
  const button = (text: string, type = "button") => {
    const b = document.createElement("button");
    b.type = type as "button";
    b.textContent = text;
    document.body.append(b);
    return b;
  };

  it("knows what a submit looks like", () => {
    expect(isSubmitLike(button("Submit application", "submit"))).toBe(true);
    expect(isSubmitLike(button("Apply now"))).toBe(true);
    expect(isSubmitLike(button("Save and Continue", "submit"))).toBe(false);
    expect(isSubmitLike(button("Next"))).toBe(false);
  });

  it("refuses to press Submit, even through the wizard and choice helpers", () => {
    expect(() => clickWizardNext(button("Submit", "submit"))).toThrow(SubmitGuardError);
    expect(() => clickWizardNext(button("Review"))).toThrow(SubmitGuardError);
    expect(() => pressChoice(button("Submit"), "Submit")).toThrow(SubmitGuardError);
    expect(() => pressChoice(button("No"), "Yes")).toThrow(/doesn't match/);
    const next = button("Save and Continue");
    const spy = vi.fn();
    next.addEventListener("click", spy);
    clickWizardNext(next);
    expect(spy).toHaveBeenCalledOnce();
  });

  it("is the only place in adapter or extension code that clicks", () => {
    const roots = ["packages/adapters/src", "apps/extension/src"].map((p) =>
      join(process.cwd(), p),
    );
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && !p.endsWith("safe-click.ts")) {
          const src = readFileSync(p, "utf8");
          if (/\.(click|requestSubmit|submit)\s*\(/.test(src)) offenders.push(p);
        }
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });
});
