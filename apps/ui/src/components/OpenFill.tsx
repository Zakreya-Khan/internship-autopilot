import { useState } from "react";
import { api, isSupportedUrl } from "../api.ts";

/**
 * Open & fill: opens an approved application's page in a new tab, where the browser extension
 * fills it. You check the page and press the site's Submit button yourself.
 */
export function OpenFill({
  id,
  company,
  primary = true,
}: {
  id: number;
  company: string;
  primary?: boolean;
}) {
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "opened"; supported: boolean } | { kind: "error"; message: string }
  >({ kind: "idle" });
  return (
    <span className="open-fill">
      <button
        className={primary ? undefined : "quiet"}
        onClick={() =>
          void openAndFill(id).then(
            (r) => setState({ kind: "opened", supported: r.supported }),
            (e: Error) => setState({ kind: "error", message: e.message }),
          )
        }
      >
        Open &amp; fill
      </button>
      {state.kind === "error" ? <span role="alert">{state.message}</span> : null}
      {state.kind === "opened" ? (
        <span role="status" className="handoff small">
          Opened {company} in a new tab.{" "}
          {state.supported
            ? "The extension fills the form there. Check every field, then press the site's Submit button yourself."
            : "This site isn't one the extension fills by itself: open the extension's side panel there and press “Fill this page”, or fill it by hand."}{" "}
          Nothing filled? Check the extension is installed and has the token from Settings.
        </span>
      ) : null}
    </span>
  );
}

/**
 * Open & fill: open the application's page in a new tab; the extension fills it there.
 * The tab is opened before the request, so the browser doesn't block it as a pop-up, and it
 * gets no handle back to this page.
 */
export async function openAndFill(id: number): Promise<{ applyUrl: string; supported: boolean }> {
  const tab = window.open("about:blank", "_blank");
  try {
    const { applyUrl } = await api.launch(id);
    if (tab) {
      tab.opener = null;
      tab.location.href = applyUrl;
    } else {
      window.open(applyUrl, "_blank", "noopener");
    }
    return { applyUrl, supported: isSupportedUrl(applyUrl) };
  } catch (e) {
    tab?.close();
    throw e;
  }
}
