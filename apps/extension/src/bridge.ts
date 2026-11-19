// Runs on your review UI (the local server's own address, nothing else). It lets the page see that
// the extension is installed and ready, and lets the page start the fill run while it's open.
// Only the session's progress (company, role, phase) goes back to the page, never field values.
import { DEFAULT_BASE_URL, loadConfig } from "./api.ts";
import type { ToBackground } from "./messages.ts";
import type { SessionState } from "./session.ts";

export interface BridgeStatus {
  ready: boolean;
  problem: string | null;
  phase: SessionState["phase"];
  company: string | null;
  title: string | null;
  remaining: number;
  submittedCount: number;
  message: string | null;
}

/** What the page may see of the session. */
export function bridgeStatus(s: SessionState, token: string): BridgeStatus {
  return {
    ready: Boolean(token),
    problem: token ? null : "The extension has no token yet: paste it on its options page.",
    phase: s.phase,
    company: s.application?.company ?? null,
    title: s.application?.title ?? null,
    remaining: s.remaining,
    submittedCount: s.submittedCount,
    message: s.message,
  };
}

/** The page asks: "autorun" (start if idle) or "status". Anything else is ignored. */
export function isBridgeRequest(
  data: unknown,
): data is { source: "ia-ui"; type: "autorun" | "status" } {
  const d = data as { source?: unknown; type?: unknown } | null;
  return d?.source === "ia-ui" && (d.type === "autorun" || d.type === "status");
}

async function main(): Promise<void> {
  const { baseUrl, token } = await loadConfig();
  // Only the review UI the extension is set up for: not any other page on this computer.
  if (new URL(baseUrl || DEFAULT_BASE_URL).origin !== location.origin) return;
  document.documentElement.dataset.iaExtension = "1";
  const reply = (state: SessionState) =>
    window.postMessage(
      { source: "ia-extension", type: "status", status: bridgeStatus(state, token) },
      location.origin,
    );
  const ask = (msg: ToBackground) =>
    (chrome.runtime.sendMessage(msg) as Promise<SessionState>).then(reply, () => {
      /* the extension was reloaded: the page shows it as not connected */
    });
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin || !isBridgeRequest(e.data)) return;
    void ask({ type: e.data.type === "autorun" ? "session:auto" : "session:get" });
  });
  void ask({ type: "session:get" });
}

if (typeof chrome !== "undefined" && chrome.runtime?.id) void main();
