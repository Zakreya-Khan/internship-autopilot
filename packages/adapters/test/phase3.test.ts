// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractPageFields, fillForm, generic, pickAdapter } from "../src/index.ts";

function load() {
  const html = readFileSync(join(process.cwd(), "fixtures/forms/generic.html"), "utf8");
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1]!;
}

describe("generic adapter", () => {
  it("lists the application form's fields, never the password or the site search", () => {
    load();
    const fields = extractPageFields(document);
    expect(fields.map((f) => [f.label, f.type])).toEqual([
      ["your full name", "text"],
      ["e-mail", "text"],
      ["cv upload", "file"],
      ["do you need visa sponsorship?", "radio"],
      ["tell us about a project you're proud of", "textarea"],
      ["favourite snack", "text"],
    ]);
    expect(fields.find((f) => f.type === "radio")?.options).toEqual(["yes", "no"]);
    expect(document.querySelectorAll("[data-ia-key]").length).toBe(7); // radios share one key
  });

  it("fills mapped fields by their tags and outlines the submit button", async () => {
    load();
    const fields = extractPageFields(document);
    const key = (label: string) => fields.find((f) => f.label === label)!.key;
    expect(pickAdapter(new URL("https://careers.small-startup.test/apply"), document)?.id).toBe(
      "generic",
    );
    const results = await fillForm(
      generic,
      document,
      [
        {
          key: key("your full name"),
          label: "",
          type: "text",
          value: "Alex Example",
          required: true,
        },
        {
          key: key("do you need visa sponsorship?"),
          label: "",
          type: "radio",
          value: "No",
          required: false,
        },
      ],
      {},
    );
    expect(results.map((r) => r.status)).toEqual(["filled", "filled"]);
    expect((document.getElementById("a1") as HTMLInputElement).value).toBe("Alex Example");
    expect(document.querySelector<HTMLInputElement>('input[value="n"]')!.checked).toBe(true);
    expect(generic.locateSubmit(document)?.textContent).toBe("Send application");
  });
});

describe("question labels on Lever and Ashby custom questions (pass 2)", () => {
  it("reads Lever card questions from .application-label and groups same-name checkboxes", () => {
    // Fictional, shaped like a Lever application's custom-question cards.
    document.body.innerHTML = `
      <form>
        <input name="name" aria-label="Full name">
        <input name="email" aria-label="Email">
        <ul>
          <li class="application-question custom-question">
            <div class="application-label"><div class="text">Which languages do you speak?<span class="required">✱</span></div></div>
            <div class="application-field"><ul>
              <li><label><input type="checkbox" name="cards[abc][field0]" value="English" required><span>English</span></label></li>
              <li><label><input type="checkbox" name="cards[abc][field0]" value="Spanish" required><span>Spanish</span></label></li>
            </ul></div>
          </li>
          <li class="application-question custom-question">
            <div class="application-label"><div class="text">When do you graduate?</div></div>
            <div class="application-field"><input type="text" name="cards[def][field0]"></div>
          </li>
        </ul>
      </form>`;
    const fields = extractPageFields(document);
    expect(fields.map((f) => [f.label, f.type])).toEqual([
      ["full name", "text"],
      ["email", "text"],
      ["which languages do you speak?", "multi_select"],
      ["when do you graduate?", "text"],
    ]);
    expect(fields[2]!.options).toEqual(["english", "spanish"]);
    expect(fields[2]!.required).toBe(true);
  });

  it("reads an Ashby yes/no question whose label points at the field's name", () => {
    document.body.innerHTML = `
      <div class="ashby-application-form-container">
        <div class="ashby-application-form-field-entry">
          <label class="ashby-application-form-question-title" for="q-name">Name</label>
          <input id="q-name" name="q-name" type="text">
        </div>
        <div class="ashby-application-form-field-entry">
          <label class="ashby-application-form-question-title" for="1111-2222">Are you authorized to work in the US?</label>
          <div class="ashby-application-form-input-yesno">
            <button data-option="yes">Yes</button><button data-option="no">No</button>
            <input type="checkbox" name="1111-2222">
          </div>
        </div>
      </div>`;
    const fields = extractPageFields(document);
    expect(fields.map((f) => f.label)).toEqual(["name", "are you authorized to work in the us?"]);
  });

  it("skips react-select's hidden required proxies", () => {
    document.body.innerHTML = `
      <form>
        <input name="first" aria-label="First name">
        <div class="select__container">
          <label id="q1-label" for="q1">How did you hear about this job?</label>
          <input id="q1" role="combobox" aria-labelledby="q1-label">
          <input required tabindex="-1" aria-hidden="true" class="requiredInput" value="">
        </div>
      </form>`;
    expect(extractPageFields(document).map((f) => f.label)).toEqual([
      "first name",
      "how did you hear about this job?",
    ]);
  });
});
