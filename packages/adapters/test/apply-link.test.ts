// @vitest-environment happy-dom
// Finding the "Apply" link on a job description page. Links only, never buttons. Fictional pages.
import { describe, expect, it } from "vitest";
import { findApplyLink } from "../src/index.ts";

const page = (html: string) => {
  document.body.innerHTML = html;
  return document;
};
const HERE = new URL("https://careers.example.com/jobs/42");

describe("findApplyLink", () => {
  it("finds the one Apply link on the same site or a known job site", () => {
    expect(findApplyLink(page(`<a href="/jobs/42/apply">Apply now</a>`), HERE)).toBe(
      "https://careers.example.com/jobs/42/apply",
    );
    expect(
      findApplyLink(
        page(`<a href="https://job-boards.greenhouse.io/example/jobs/42">Apply for this job</a>`),
        HERE,
      ),
    ).toBe("https://job-boards.greenhouse.io/example/jobs/42");
    // The same destination twice (header and footer) is still one link.
    expect(
      findApplyLink(
        page(`<a href="/apply/42">Apply</a><p>…</p><a href="/apply/42"> Apply </a>`),
        HERE,
      ),
    ).toBe("https://careers.example.com/apply/42");
  });

  it("never follows buttons, scripts, other sites, anchors, or an ambiguous choice", () => {
    expect(findApplyLink(page(`<button>Apply</button>`), HERE)).toBeNull();
    expect(findApplyLink(page(`<a href="javascript:apply()">Apply</a>`), HERE)).toBeNull();
    expect(findApplyLink(page(`<a href="mailto:jobs@example.com">Apply</a>`), HERE)).toBeNull();
    expect(
      findApplyLink(page(`<a href="https://tracker.example.org/x">Apply</a>`), HERE),
    ).toBeNull();
    expect(findApplyLink(page(`<a href="#apply">Apply</a>`), HERE)).toBeNull();
    expect(
      findApplyLink(page(`<a href="/apply/1">Apply</a><a href="/apply/2">Apply</a>`), HERE),
    ).toBeNull();
    // Text that merely mentions applying isn't the Apply link.
    expect(findApplyLink(page(`<a href="/faq">How to apply</a>`), HERE)).toBeNull();
  });
});
