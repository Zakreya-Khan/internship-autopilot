import { classifyQuestion } from "@ia/core";
import { describe, expect, it } from "vitest";
import {
  fetchLeverQuestions,
  fetchPostingDetail,
  leverApplyUrl,
  parseLeverApplyPage,
} from "../src/index.ts";
import type { FetchFn } from "../src/index.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/>/g, "&gt;");
const template = (o: unknown) =>
  `<input type="hidden" value="${esc(JSON.stringify(o))}" name="@NAME@">`;

/** A fictional page modeled on Lever's server-rendered application form. */
function applyPage(): string {
  const card = template({
    text: "Work Eligibility",
    type: "posting",
    fields: [
      {
        type: "multiple-choice",
        text: "Are you legally authorized to work in the United States?",
        required: true,
        options: [{ text: "Yes" }, { text: "No" }],
      },
      { type: "textarea", text: "Why do you want to work at Acme?", required: true },
      { type: "text", text: "  ", required: false },
      { type: "dropdown", text: "Preferred team", options: [{ text: "Data" }, { text: "Web" }] },
    ],
  }).replace("@NAME@", "cards[c-1][baseTemplate]");
  const survey = template({
    text: "Demographic survey",
    type: "survey",
    fields: [
      {
        type: "multiple-select",
        text: "I identify my ethnicity as...",
        options: [{ text: "Asian" }, { text: "Decline to answer" }],
      },
    ],
  }).replace("@NAME@", "surveysResponses[s-1][baseTemplate]");
  return `<!doctype html><html><body>
  <form id="application-form" method="POST">
    <input type="file" name="resume" id="resume-upload-input">
    <input type="text" name="name" required>
    <input name="email" type="email" pattern="[a-z]+&amp;[a-z]+" required>
    <input type="text" name="phone">
    <input type="hidden" name="selectedLocation" id="selected-location">
    <input type="text" name="location">
    <input type="text" name="org" required>
    <input type="checkbox" name="pronouns" value="They/them">
    <input type="text" name="urls[LinkedIn]">
    <input type="text" name="urls[Github]">
    <input type="text" name="urls[Other Website]">
    <input type="text" name="urls[Video Link ]">
    <textarea name="comments"></textarea>
    ${card}
    <input type="radio" name="cards[c-1][field0]" value="Yes"><input type="radio" name="cards[c-1][field0]" value="No">
    <select name="eeo[gender]"><option value="">Select ...</option><option value="Male">Male</option><option value="Decline to self-identify">Decline to self-identify</option></select>
    <input type="radio" name="eeo[race]" value="Asian"><input type="radio" name="eeo[race]" value="Decline to self-identify">
    <input type="text" name="eeo[disabilitySignature]">
    <input type="text" name="eeo[disabilitySignatureDate]">
    ${survey}
    <button type="submit" id="btn-submit">Submit application</button>
  </form></body></html>`;
}

describe("parseLeverApplyPage", () => {
  const qs = parseLeverApplyPage(applyPage());
  const by = (key: string) => qs.find((q) => q.key === key);

  it("reads the standard fields with their real names and required marks", () => {
    expect(by("resume")).toMatchObject({ label: "Resume/CV", type: "file", required: true });
    expect(by("name")).toMatchObject({ label: "Full name", required: true });
    expect(by("email")).toMatchObject({ required: true });
    expect(by("phone")?.required).toBe(false);
    expect(by("org")).toMatchObject({ label: "Current company", required: true });
    expect(by("comments")).toMatchObject({ type: "textarea" });
    // Hidden helper inputs and the pronouns checkbox are not questions.
    expect(by("selectedLocation")).toBeUndefined();
    expect(by("pronouns")).toBeUndefined();
  });

  it("labels Lever's URL inputs", () => {
    expect(by("urls[LinkedIn]")?.label).toBe("LinkedIn URL");
    expect(by("urls[Github]")?.label).toBe("GitHub URL");
    expect(by("urls[Other Website]")?.label).toBe("Other Website");
    expect(by("urls[Video Link ]")?.label).toBe("Video Link");
  });

  it("reads custom cards from the hidden template, keyed by input name", () => {
    expect(by("cards[c-1][field0]")).toEqual({
      key: "cards[c-1][field0]",
      label: "Are you legally authorized to work in the United States?",
      required: true,
      type: "radio",
      options: ["Yes", "No"],
    });
    expect(by("cards[c-1][field1]")).toMatchObject({ type: "textarea", required: true });
    // A field with no text is skipped but keeps its index, so the next key still matches the page.
    expect(by("cards[c-1][field2]")).toBeUndefined();
    expect(by("cards[c-1][field3]")).toMatchObject({
      type: "select",
      options: ["Data", "Web"],
    });
  });

  it("reads the voluntary EEO block and surveys, never the disability signature", () => {
    expect(by("eeo[gender]")).toMatchObject({
      label: "Gender",
      type: "select",
      required: false,
      options: ["Male", "Decline to self-identify"],
    });
    expect(by("eeo[race]")).toMatchObject({
      type: "radio",
      options: ["Asian", "Decline to self-identify"],
    });
    expect(qs.some((q) => q.key.includes("disabilitySignature"))).toBe(false);
    expect(by("surveysResponses[s-1][responses][field0]")).toMatchObject({
      type: "multi_select",
      options: ["Asian", "Decline to answer"],
    });
  });

  it("lists each radio group once, in page order: standard, cards, EEO, survey", () => {
    expect(qs.filter((q) => q.key === "cards[c-1][field0]")).toHaveLength(1);
    const order = qs.map((q) => q.key);
    expect(order.indexOf("comments")).toBeLessThan(order.indexOf("cards[c-1][field0]"));
    expect(order.indexOf("cards[c-1][field0]")).toBeLessThan(order.indexOf("eeo[gender]"));
    expect(order.indexOf("eeo[gender]")).toBeLessThan(
      order.indexOf("surveysResponses[s-1][responses][field0]"),
    );
  });

  it("returns nothing for a page without the application form", () => {
    expect(parseLeverApplyPage("<html><body><h1>This job is closed</h1></body></html>")).toEqual(
      [],
    );
  });

  it("survives a malformed template", () => {
    const html = `<form id="application-form"><input type="text" name="name">
      <input type="hidden" value="{not json" name="cards[x][baseTemplate]"></form>`;
    expect(parseLeverApplyPage(html).map((q) => q.key)).toEqual(["name"]);
  });

  it("leaves sensitive questions for you, as it does for any other form", () => {
    expect(classifyQuestion(by("cards[c-1][field1]")!).kind).toBe("open");
    expect(classifyQuestion(by("eeo[gender]")!)).toMatchObject({
      kind: "known",
      field: "eeo_gender",
    });
    expect(classifyQuestion(by("cards[c-1][field0]")!)).toMatchObject({
      kind: "known",
      field: "authorized_us",
    });
  });
});

const calls = () => {
  const urls: string[] = [];
  return { urls, record: (u: string) => urls.push(u) };
};

describe("fetchLeverQuestions", () => {
  it("fetches the apply page politely and parses it", async () => {
    const c = calls();
    const fetchFn: FetchFn = async (url, init) => {
      c.record(url);
      expect(new Headers(init?.headers).get("User-Agent")).toMatch(/^internship-autopilot/);
      return new Response(applyPage(), { headers: { "content-type": "text/html" } });
    };
    const qs = await fetchLeverQuestions("acme", "11111111-2222-3333-4444-555555555555", {
      fetch: fetchFn,
    });
    expect(c.urls).toEqual([
      "https://jobs.lever.co/acme/11111111-2222-3333-4444-555555555555/apply",
    ]);
    expect(qs.length).toBeGreaterThan(10);
  });

  it("builds the EU URL", () => {
    expect(leverApplyUrl("acme", "abc", true)).toBe("https://jobs.eu.lever.co/acme/abc/apply");
  });

  it("gives an empty list for a posting that has been taken down", async () => {
    const fetchFn: FetchFn = async () => new Response("gone", { status: 404 });
    expect(await fetchLeverQuestions("acme", "x", { fetch: fetchFn, retries: 0 })).toEqual([]);
  });

  it("throws on a server error so the caller can retry later", async () => {
    const fetchFn: FetchFn = async () => new Response("busy", { status: 503 });
    await expect(
      fetchLeverQuestions("acme", "x", { fetch: fetchFn, retries: 0, wait: async () => {} }),
    ).rejects.toThrow(/503/);
  });
});

describe("fetchPostingDetail for Lever", () => {
  const id = "11111111-2222-3333-4444-555555555555";
  const posting = { ats: "lever" as const, boardToken: "acme", atsJobId: id };
  const api = {
    id,
    text: "Data Intern",
    hostedUrl: `https://jobs.lever.co/acme/${id}`,
    descriptionPlain: "Python.",
  };

  it("returns the description and the real questions together", async () => {
    const fetchFn: FetchFn = async (url) =>
      url.includes("api.lever.co") ? Response.json(api) : new Response(applyPage());
    const d = await fetchPostingDetail(posting, { fetch: fetchFn });
    expect(d?.descriptionText).toBe("Python.");
    expect(d?.questions?.some((q) => q.key === "cards[c-1][field0]")).toBe(true);
  });

  it("keeps the description and leaves questions unset when the page can't be read", async () => {
    const fetchFn: FetchFn = async (url) =>
      url.includes("api.lever.co") ? Response.json(api) : new Response("busy", { status: 503 });
    const d = await fetchPostingDetail(posting, {
      fetch: fetchFn,
      retries: 0,
      wait: async () => {},
    });
    expect(d?.descriptionText).toBe("Python.");
    expect(d?.questions).toBeNull();
  });
});
