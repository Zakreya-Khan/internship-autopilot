import type { StateBroadcast, ToBackground } from "./messages.ts";
import type { SessionState } from "./session.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const send = (msg: ToBackground) => chrome.runtime.sendMessage(msg) as Promise<SessionState>;

function render(s: SessionState): void {
  $("phase").textContent =
    {
      idle: "No session running.",
      loading: "Loading the next application…",
      filling: "Filling the form…",
      waiting_for_you: "Your turn.",
      done: "All approved applications are done.",
      error: "Something went wrong.",
    }[s.phase] ?? s.phase;
  $("message").textContent = s.message ?? "";
  $("app").textContent = s.application ? `${s.application.title} · ${s.application.company}` : "";
  $("counts").textContent =
    s.phase === "idle" ? "" : `${s.submittedCount} submitted · ${s.remaining} in queue`;
  const list = $<HTMLUListElement>("issues");
  list.replaceChildren(
    ...s.mismatches.map((m) =>
      li(`${m.label}: the page shows "${m.seen ?? ""}", the plan said "${m.planned ?? ""}"`),
    ),
    ...s.problems.map((p) => li(`${p.key}: ${p.reason ?? p.status}`)),
    ...(s.application?.fields ?? [])
      .filter((f) => f.flag === "grey" && f.note)
      .map((f) => li(`${f.label}: ${f.note}`)),
    ...(s.closedSkipped ?? []).map((c) =>
      li(`Closed since approval, skipped: ${c.title} · ${c.company} (${c.reason})`),
    ),
  );
  const running = !["idle", "done", "error"].includes(s.phase);
  $<HTMLButtonElement>("start").hidden = running;
  $<HTMLButtonElement>("confirm").hidden = s.phase !== "waiting_for_you";
  $<HTMLButtonElement>("skip").hidden = !running;
  $<HTMLButtonElement>("end").hidden = !running;
  // In a session: for a site the extension doesn't know. Outside one: for the tab you opened
  // with "Open & fill" in the review UI, on such a site.
  const generic = $<HTMLButtonElement>("generic");
  generic.hidden = running && !s.needsGeneric;
  generic.textContent = running ? "Fill this page" : "Fill this page (opened from the review UI)";
}

function li(text: string): HTMLLIElement {
  const el = document.createElement("li");
  el.textContent = text;
  return el;
}

$("start").addEventListener("click", () => void send({ type: "session:start" }).then(render));
$("confirm").addEventListener("click", () => void send({ type: "session:confirm" }).then(render));
$("skip").addEventListener("click", () => void send({ type: "session:skip" }).then(render));
$("generic").addEventListener("click", () => {
  void (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;
    // Chrome asks you to allow this one site. Nothing is injected without that.
    const granted = await chrome.permissions.request({ origins: [`${new URL(tab.url).origin}/*`] });
    if (granted) render(await send({ type: "session:inject", tabId: tab.id }));
  })();
});
$("end").addEventListener("click", () => void send({ type: "session:end" }).then(render));
chrome.runtime.onMessage.addListener((msg: StateBroadcast) => {
  if (msg.type === "state") render(msg.state);
});
void send({ type: "session:get" }).then(render);
