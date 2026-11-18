// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSettings } from "../src/api.ts";
import { parseRoute } from "../src/App.tsx";
import { Settings } from "../src/pages/Settings.tsx";

const base: ProviderSettings = {
  selected: "api",
  cliPath: null,
  labels: { api: "Anthropic API key", cli: "Claude CLI (subscription)" },
  ready: true,
  reason: null,
  api: { available: true, source: "environment", hint: "…wxyz" },
  cli: {
    found: true,
    path: "/usr/local/bin/claude",
    version: "2.1.999",
    signedIn: true,
    authMethod: "claude.ai",
    problem: null,
  },
};

let calls: { method: string; url: string; body: unknown }[];
let state: ProviderSettings;

beforeEach(() => {
  localStorage.setItem("ia-token", "t");
  calls = [];
  state = structuredClone(base);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? "GET", url, body });
    if (url === "/api/settings/provider/test")
      return Response.json({ ok: true, model: "claude-haiku-5-5", ms: 1200 });
    if (url === "/api/settings/provider" && init.method === "PUT")
      state = { ...state, selected: body.provider ?? state.selected };
    if (url === "/api/settings/api-key")
      state = { ...state, api: { available: true, source: "saved", hint: "…abcd" } };
    return Response.json(state);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Settings", () => {
  it("is routed at #/settings", () => {
    expect(parseRoute("#/settings")).toEqual({ page: "settings" });
  });

  it("shows both providers' status, switches, and tests a connection", async () => {
    render(<Settings />);
    expect(await screen.findByText(/Key found from ANTHROPIC_API_KEY \(…wxyz\)/)).toBeTruthy();
    expect(screen.getByText(/version 2\.1\.999, signed in \(claude\.ai\)/)).toBeTruthy();
    expect(screen.getByText(/No Batch API/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/Claude CLI \(subscription\)/));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "PUT",
        url: "/api/settings/provider",
        body: { provider: "cli" },
      }),
    );
    expect(await screen.findByText("In use: Claude CLI (subscription).")).toBeTruthy();

    fireEvent.click(screen.getAllByText("Test connection")[1]!);
    expect(await screen.findByText(/Works \(claude-haiku-5-5, 1\.2 s\)/)).toBeTruthy();
    expect(calls.at(-1)).toMatchObject({
      url: "/api/settings/provider/test",
      body: { provider: "cli" },
    });
  });

  it("sends a pasted key once and clears the box; the page only ever shows its last 4", async () => {
    render(<Settings />);
    const box = (await screen.findByLabelText("Paste an Anthropic API key")) as HTMLInputElement;
    expect(box.type).toBe("password");
    fireEvent.change(box, { target: { value: "sk-ant-fictional-key-abcd" } });
    fireEvent.click(screen.getByText("Save key"));
    expect(await screen.findByText(/saved in data\/ \(…abcd\)/)).toBeTruthy();
    expect(box.value).toBe("");
    expect(document.body.textContent).not.toContain("sk-ant-fictional-key");
  });

  it("explains what's missing when the CLI isn't signed in", async () => {
    state = {
      ...state,
      selected: "cli",
      ready: false,
      reason: "not signed in",
      cli: { ...state.cli, signedIn: false },
    };
    render(<Settings />);
    expect(await screen.findByText(/not signed in: run "claude" once/)).toBeTruthy();
    expect(screen.getByText(/isn't ready: not signed in/)).toBeTruthy();
  });
});
