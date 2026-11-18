// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fillForm, pickAdapter, runWizard, smartrecruiters, workday } from "../src/index.ts";
import type { FillField } from "../src/index.ts";

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
  required: true,
  ...extra,
});
const pdf = () =>
  new File([new Uint8Array([37, 80, 68, 70])], "Resume.pdf", { type: "application/pdf" });

const STEP1 = `
  <div data-automation-id="applyFlowPage">
    <h2 data-automation-id="progressBarActiveStep">My Information</h2>
    <div data-automation-id="formField-firstName"><label for="fn">Given Name(s)</label><input id="fn" data-automation-id="legalNameSection_firstName"></div>
    <div data-automation-id="formField-lastName"><label for="ln">Family Name</label><input id="ln" data-automation-id="legalNameSection_lastName"></div>
    <div data-automation-id="formField-email"><label for="em">Email Address</label><input id="em" data-automation-id="email"></div>
    <div data-automation-id="formField-source"><label>How Did You Hear About Us?</label>
      <button type="button" aria-haspopup="listbox" id="src">Select One</button></div>
    <button data-automation-id="pageFooterNextButton" type="button">Save and Continue</button>
  </div>`;
const STEP2 = `
  <div data-automation-id="applyFlowPage">
    <h2 data-automation-id="progressBarActiveStep">My Experience</h2>
    <div data-automation-id="formField-resume"><label for="up">Resume/CV</label><input id="up" type="file" data-automation-id="file-upload-input-ref"></div>
    <fieldset data-automation-id="formField-sponsor"><legend>Will you now or in the future require sponsorship?</legend>
      <label><input type="radio" name="sp" value="Yes"> Yes</label><label><input type="radio" name="sp" value="No"> No</label></fieldset>
    <button data-automation-id="pageFooterNextButton" type="button">Save and Continue</button>
  </div>`;
const REVIEW = `
  <div data-automation-id="applyFlowPage">
    <h2 data-automation-id="progressBarActiveStep">Review</h2>
    <div data-automation-id="reviewJobApplicationPage">Everything you entered.</div>
    <button data-automation-id="pageFooterSubmitButton" type="button">Submit</button>
  </div>`;

/** A tiny stand-in for Workday's step navigation and listbox popups. */
function mountWorkday(opts: { failOnStep2?: boolean } = {}) {
  const steps = [STEP1, STEP2, REVIEW];
  let i = 0;
  const submitClicks = vi.fn();
  const render = () => {
    document.body.innerHTML = steps[i]!;
    document
      .querySelector("[data-automation-id=pageFooterNextButton]")
      ?.addEventListener("click", () => {
        if (opts.failOnStep2 && i === 1) {
          document
            .querySelector("[data-automation-id=applyFlowPage]")!
            .insertAdjacentHTML(
              "beforeend",
              '<div data-automation-id="errorMessage">Enter a value for this required field</div>',
            );
          return;
        }
        i++;
        render();
      });
    document
      .querySelector("[data-automation-id=pageFooterSubmitButton]")
      ?.addEventListener("click", submitClicks);
    const src = document.getElementById("src");
    src?.addEventListener("click", () => {
      const list = document.createElement("ul");
      list.setAttribute("role", "listbox");
      for (const t of ["Job Board", "Referral", "Other"]) {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        li.textContent = t;
        li.addEventListener("click", () => {
          src.textContent = t;
          list.remove();
        });
        list.append(li);
      }
      document.body.append(list);
    });
  };
  render();
  return { submitClicks, step: () => i };
}

const FIELDS: FillField[] = [
  f("first_name", "First Name", "Alex"),
  f("last_name", "Last Name", "Example"),
  f("email", "Email", "alex@example.com"),
  f("how_heard", "How Did You Hear About Us?", "Job Board"),
  f("resume", "Resume/CV", null, { attach: "resume", type: "file" }),
  f("sponsor", "Will you now or in the future require sponsorship?", "No", { type: "radio" }),
];

describe("Workday", () => {
  it("fills each step, presses only Save and Continue, and stops on Review", async () => {
    const wd = mountWorkday();
    const out = await runWizard(
      workday,
      document,
      FIELDS,
      { resume: pdf() },
      { settleMs: 0, stepTimeoutMs: 1000 },
    );
    expect(out).toMatchObject({ steps: 3, stoppedAt: "review", message: null });
    expect(Object.fromEntries(out.results.map((r) => [r.key, r.status]))).toEqual({
      first_name: "filled",
      last_name: "filled",
      email: "filled",
      how_heard: "filled",
      resume: "filled",
      sponsor: "filled",
    });
    expect(out.results.find((r) => r.key === "how_heard")?.seen).toBe("Job Board");
    const submit = document.querySelector<HTMLElement>(
      "[data-automation-id=pageFooterSubmitButton]",
    )!;
    expect(submit.getAttribute("data-ia-highlight")).toBe("submit");
    expect(wd.submitClicks).not.toHaveBeenCalled();
    expect(workday.nextStep!(document)).toBeNull();
  });

  it("stops when a step reports an error, instead of pushing on", async () => {
    const wd = mountWorkday({ failOnStep2: true });
    const out = await runWizard(
      workday,
      document,
      FIELDS,
      {},
      { settleMs: 0, stepTimeoutMs: 1000 },
    );
    expect(out.stoppedAt).toBe("blocked");
    expect(out.message).toMatch(/Enter a value/);
    expect(wd.step()).toBe(1);
  });

  it("leaves sign-in to you", () => {
    document.body.innerHTML =
      '<div data-automation-id="signInContent"><input type="password"></div>';
    expect(workday.needsSignIn!(document)).toBe(true);
    expect(workday.formRoot(document)).toBeNull();
    expect(
      pickAdapter(
        new URL("https://acme.wd5.myworkdayjobs.com/en-US/careers/job/x_R123/apply"),
        document,
      )?.id,
    ).toBe("workday");
  });
});

describe("SmartRecruiters", () => {
  it("fills by its field ids, including the email confirmation", async () => {
    const html = readFileSync(join(process.cwd(), "fixtures/forms/smartrecruiters.html"), "utf8");
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1]!;
    const results = await fillForm(
      smartrecruiters,
      document,
      [
        f("first_name", "First name", "Alex"),
        f("email", "Email", "alex@example.com"),
        f("confirm_email", "Confirm your email", "alex@example.com"),
        f("resume", "Resume", null, { attach: "resume", type: "file" }),
      ],
      { resume: pdf() },
    );
    expect(results.map((r) => r.status)).toEqual(["filled", "filled", "filled", "filled"]);
    expect((document.getElementById("confirm-email-input") as HTMLInputElement).value).toBe(
      "alex@example.com",
    );
    expect(smartrecruiters.locateSubmit(document)?.textContent).toBe("Submit");
  });
});
