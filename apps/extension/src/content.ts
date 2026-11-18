import type { Adapter } from "@ia/adapters";
import { base64ToFile, fillForm, highlightSubmit, pickAdapter } from "@ia/adapters";
import type { ContentReadyReply, ToBackground } from "./messages.ts";

const send = <T>(msg: ToBackground) => chrome.runtime.sendMessage(msg) as Promise<T>;

function waitFor<T>(probe: () => T | null, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const v = probe();
      if (v) return resolve(v);
      if (Date.now() - start > timeoutMs) return resolve(null);
      setTimeout(tick, 300);
    };
    tick();
  });
}

/** Watch for the site's confirmation page, which only appears after you press Submit. */
function watchForConfirmation(adapter: Adapter): void {
  let reported = false;
  const check = () => {
    if (reported) return;
    if (adapter.isConfirmation(document, new URL(location.href))) {
      reported = true;
      observer.disconnect();
      void send({ type: "content:confirmed", url: location.href });
    }
  };
  const observer = new MutationObserver(check);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  setInterval(check, 1500);
  check();
}

async function main(): Promise<void> {
  const job = await send<ContentReadyReply>({ type: "content:ready", url: location.href });
  if (!job) return;
  const adapter = pickAdapter(new URL(location.href), document);
  if (!adapter) {
    await send({
      type: "content:error",
      message: "This site isn't supported yet. Fill it by hand.",
    });
    return;
  }
  if (job.mode === "watch") {
    watchForConfirmation(adapter);
    return;
  }
  // Single-page apps render the form after load.
  const root = await waitFor(() => adapter.formRoot(document), 15_000);
  if (!root) {
    await send({ type: "content:error", message: "No application form found on this page." });
    return;
  }
  const app = job.application;
  const files = Object.fromEntries(
    Object.entries(app.files).map(([kind, f]) => [kind, base64ToFile(f!.base64, f!.name)]),
  );
  const results = fillForm(adapter, document, app.fields, files);
  highlightSubmit(adapter, document);
  await send({ type: "content:filled", results, snapshotHtml: root.outerHTML });
  watchForConfirmation(adapter);
}

void main();
