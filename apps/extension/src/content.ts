import type { Adapter, FieldResult, FillField } from "@ia/adapters";
import {
  base64ToFile,
  extractPageFields,
  fillForm,
  findApplyLink,
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

const FIRST_LOOK_MS = 3000;
/** At most this many "Apply" links per application, so two pages can't send the tab in circles. */
const MAX_FOLLOWS = 2;
const followKey = (id: number) => `ia-followed-${id}`;
function followed(id: number): number {
  try {
    return Number(sessionStorage.getItem(followKey(id)) ?? 0);
  } catch {
    return MAX_FOLLOWS;
  }
}
function markFollowed(id: number): void {
  try {
    sessionStorage.setItem(followKey(id), String(followed(id) + 1));
  } catch {
    /* storage unavailable: then followed() says no more */
  }
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
  // Look for the form briefly. If this is the job description and the form is one page further,
  // behind an "Apply" link, go to that page (a page load, never a click); it's filled there.
  const app = job.application;
  let root = await waitFor(() => adapter.formRoot(document), FIRST_LOOK_MS, 300);
  if (!root) {
    const next =
      followed(app.id) < MAX_FOLLOWS ? findApplyLink(document, new URL(location.href)) : null;
    if (next) {
      markFollowed(app.id);
      await send({ type: "content:error", message: "Going to the application form…" });
      location.assign(next);
      return;
    }
    // Single-page apps render the form after load; sign-in can take a few minutes.
    root = await waitFor(
      () => adapter.formRoot(document),
      Math.max(0, (adapter.formWaitMs ?? 15_000) - FIRST_LOOK_MS),
      300,
    );
  }
  if (!root) {
    await send({ type: "content:error", message: "No application form found on this page." });
    return;
  }
  const files = Object.fromEntries(
    Object.entries(app.files).map(([kind, f]) => [kind, base64ToFile(f!.base64, f!.name)]),
  );
  let results: FieldResult[];
  if (adapter.id === "generic") {
    // Unknown site: list the fields, let the server match them to the plan, fill only matches.
    const page = extractPageFields(document);
    const mapped = await send<FillField[]>({ type: "content:map", fields: page });
    results = await fillForm(adapter, document, mapped, files);
    highlightSubmit(adapter, document);
  } else if (adapter.nextStep) {
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
