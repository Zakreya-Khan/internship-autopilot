import { loadConfig, makeApi } from "./api.ts";
import type { StateBroadcast, ToBackground } from "./messages.ts";
import type { SessionApplication, SessionState } from "./session.ts";
import { SessionController } from "./session.ts";

const controller = new SessionController({
  api: makeApi(loadConfig),
  openTab: async (url, reuseTabId) => {
    if (reuseTabId !== null) {
      try {
        const tab = await chrome.tabs.update(reuseTabId, { url, active: true });
        if (tab?.id !== undefined) return tab.id;
      } catch {
        /* the tab was closed: open a new one */
      }
    }
    const tab = await chrome.tabs.create({ url, active: true });
    return tab.id!;
  },
  onChange: (state) => {
    void persist(state);
    const msg: StateBroadcast = { type: "state", state };
    chrome.runtime.sendMessage(msg).catch(() => {
      /* side panel closed */
    });
  },
});

// MV3 workers are stopped when idle; keep the session in session storage so it survives that.
async function persist(state: SessionState): Promise<void> {
  await chrome.storage.session.set({ state, current: controller.currentApplication() });
}

const restored = chrome.storage.session.get(["state", "current"]).then((got) => {
  if (got.state)
    controller.restore(
      got.state as SessionState,
      (got.current as SessionApplication | null) ?? null,
    );
});

chrome.runtime.onMessage.addListener((msg: ToBackground, sender, reply) => {
  void (async () => {
    await restored;
    const tabId = sender.tab?.id ?? -1;
    switch (msg.type) {
      case "session:start":
        await controller.start();
        break;
      case "session:skip":
        await controller.skip();
        break;
      case "session:confirm":
        await controller.confirmByUser();
        break;
      case "session:end":
        await controller.end();
        break;
      case "content:ready":
        reply(await controller.jobForPage(tabId, msg.url));
        return;
      case "content:filled":
        await controller.onFilled(tabId, msg.results, msg.snapshotHtml);
        break;
      case "content:confirmed":
        await controller.onConfirmed(tabId, msg.url);
        break;
      case "content:map":
        reply(await controller.mapFields(tabId, msg.fields));
        return;
      case "session:inject": {
        // Only after you granted this one site in the side panel (chrome.permissions.request).
        const id = controller.get().tabId;
        if (id !== null)
          await chrome.scripting.executeScript({
            target: { tabId: id, allFrames: true },
            files: ["content.js"],
          });
        break;
      }
      case "content:error":
        controller.note(tabId, msg.message);
        break;
      case "session:get":
        break;
    }
    reply(controller.get());
  })();
  return true; // async reply
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId !== undefined) void chrome.sidePanel.open({ windowId: tab.windowId });
});
