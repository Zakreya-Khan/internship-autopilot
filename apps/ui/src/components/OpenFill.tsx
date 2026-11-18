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
    | { kind: "idle" }
    | { kind: "opened"; supported: boolean; blocked: boolean; applyUrl: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  return (
    <span className="open-fill">
      <button
        className={primary ? undefined : "quiet"}
        onClick={() =>
          void openAndFill(id).then(
            (r) => setState({ kind: "opened", ...r }),
            (e: Error) => setState({ kind: "error", message: e.message }),
          )
        }
      >
        Open &amp; fill
      </button>
      {state.kind === "error" ? <span role="alert">{state.message}</span> : null}
      {state.kind === "opened" ? (
        <span role="status" className="handoff small">
          {state.blocked ? (
            <>
              Your browser blocked the new tab.{" "}
              <a href={state.applyUrl} target="_blank" rel="noopener noreferrer">
                Open the application page
              </a>
              .{" "}
            </>
          ) : (
            <>Opened {company} in a new tab. </>
          )}
          {state.supported
            ? "The extension fills the form there. Check every field, then press the site's Submit button yourself."
            : "The extension doesn't fill this site by itself: on that tab, open the extension's side panel and press “Fill this page” (Chrome asks you to allow the site once). Or fill it by hand."}{" "}
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
export async function openAndFill(
  id: number,
): Promise<{ applyUrl: string; supported: boolean; blocked: boolean }> {
  const tab = window.open("about:blank", "_blank");
  try {
    const { applyUrl } = await api.launch(id);
    // A blocked pop-up: the page offers a plain link instead (the launch waits 10 minutes).
    if (tab) {
      tab.opener = null;
      tab.location.href = applyUrl;
    }
    return { applyUrl, supported: isSupportedUrl(applyUrl), blocked: !tab };
  } catch (e) {
    tab?.close();
    throw e;
  }
}
