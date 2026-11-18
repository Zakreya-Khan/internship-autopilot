import type { Adapter, FieldResult } from "@ia/adapters";
import {
  base64ToFile,
  fillForm,
  highlightSubmit,
  pickAdapter,
  runWizard,
  waitFor,
} from "@ia/adapters";
import type { ContentReadyReply, ToBackground } from "./messages.ts";

const send = <T>(msg: ToBackground) => chrome.runtime.sendMessage(msg) as Promise<T>;

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
  if (adapter.needsSignIn?.(document)) {
    // Accounts and passwords are yours. The form is filled once you're signed in.
    await send({
      type: "content:error",
      message:
        "Sign in or create your account (use your password manager). Filling starts after that.",
    });
  }
  // Single-page apps render the form after load; sign-in can take a few minutes.
  const root = await waitFor(() => adapter.formRoot(document), adapter.formWaitMs ?? 15_000, 300);
  if (!root) {
    await send({ type: "content:error", message: "No application form found on this page." });
    return;
  }
  const app = job.application;
  const files = Object.fromEntries(
    Object.entries(app.files).map(([kind, f]) => [kind, base64ToFile(f!.base64, f!.name)]),
  );
  let results: FieldResult[];
  if (adapter.nextStep) {
    const outcome = await runWizard(adapter, document, app.fields, files);
    results = outcome.results;
    if (outcome.message) await send({ type: "content:error", message: outcome.message });
  } else {
    results = await fillForm(adapter, document, app.fields, files);
    highlightSubmit(adapter, document);
  }
  const snapshot = adapter.formRoot(document)?.outerHTML ?? root.outerHTML;
  await send({ type: "content:filled", results, snapshotHtml: snapshot });
  watchForConfirmation(adapter);
}

void main();
