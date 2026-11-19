import { useEffect, useRef, useState } from "react";
import type { Summary } from "../api.ts";

/** What the extension tells this page about its run (never any field values). */
export interface ExtensionStatus {
  ready: boolean;
  problem: string | null;
  phase: "idle" | "loading" | "filling" | "waiting_for_you" | "done" | "error";
  company: string | null;
  title: string | null;
  remaining: number;
  submittedCount: number;
  message: string | null;
}

const ask = (type: "autorun" | "status") =>
  window.postMessage({ source: "ia-ui", type }, window.location.origin);

/** Re-read the extension's status this often while the page is open. */
export const STATUS_MS = 3000;

/**
 * The browser extension, seen from this page: is it installed, and what is its run doing. While
 * this page is open and auto-run is on, approved applications are opened and filled one at a time:
 * when the page loads with something approved, and whenever more get approved. You press Submit.
 */
export function useExtension(summary: Summary | null) {
  const [present, setPresent] = useState(
    () => document.documentElement.dataset.iaExtension === "1",
  );
  const [status, setStatus] = useState<ExtensionStatus | null>(null);

  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source !== window || e.origin !== window.location.origin) return;
      const d = e.data as { source?: string; type?: string; status?: ExtensionStatus } | null;
      if (d?.source !== "ia-extension" || d.type !== "status" || !d.status) return;
      setPresent(true);
      setStatus(d.status);
    };
    window.addEventListener("message", on);
    ask("status");
    const t = setInterval(() => ask("status"), STATUS_MS);
    return () => {
      window.removeEventListener("message", on);
      clearInterval(t);
    };
  }, []);

  // Start the run when there's something approved: on load, when more get approved, or when you
  // turn auto-run on. A run that's going is never restarted (the extension checks).
  const seen = useRef<{ approved: number; autorun: boolean } | null>(null);
  const approved = summary?.approved ?? null;
  const autorun = summary?.autorun ?? false;
  useEffect(() => {
    if (approved === null || !present) return;
    const before = seen.current;
    seen.current = { approved, autorun };
    if (!autorun || approved === 0) return;
    if (!before || approved > before.approved || !before.autorun) ask("autorun");
  }, [approved, autorun, present]);

  return { present, status };
}

/** One line in the nav: what the run is doing. */
export function ExtensionChip({
  present,
  status,
  autorun,
}: {
  present: boolean;
  status: ExtensionStatus | null;
  autorun: boolean;
}) {
  if (!present)
    return (
      <a href="#/settings" className="nav-job muted" title="Install the extension to fill forms">
        Extension not connected
      </a>
    );
  if (status && !status.ready)
    return (
      <a href="#/settings" className="nav-job warn">
        Extension needs its token
      </a>
    );
  const what = status?.company ? `${status.company}` : "";
  const label =
    status?.phase === "filling" || status?.phase === "loading"
      ? `Filling ${what}…`
      : status?.phase === "waiting_for_you"
        ? `Your Submit: ${what}`
        : status?.phase === "error"
          ? "Extension: something went wrong"
          : autorun
            ? "Auto-fill on"
            : "Auto-fill off";
  return (
    <span className="nav-job" role="status" title={status?.message ?? undefined}>
      {label}
    </span>
  );
}
