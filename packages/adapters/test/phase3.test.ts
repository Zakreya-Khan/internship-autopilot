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
