import { DEFAULT_BASE_URL, loadConfig } from "./api.ts";

const form = document.getElementById("form") as HTMLFormElement;
const baseUrl = document.getElementById("baseUrl") as HTMLInputElement;
const token = document.getElementById("token") as HTMLInputElement;
const status = document.getElementById("status")!;

void loadConfig().then((c) => {
  baseUrl.value = c.baseUrl;
  token.value = c.token;
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const url = baseUrl.value.trim() || DEFAULT_BASE_URL;
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) {
    status.textContent = "The server must be on 127.0.0.1 or localhost.";
    return;
  }
  void chrome.storage.local.set({ baseUrl: url, token: token.value.trim() }).then(async () => {
    const res = await fetch(`${url}/api/queue`, {
      headers: { "x-ia-token": token.value.trim() },
    }).catch(() => null);
    status.textContent = res?.ok
      ? "Saved. Connected to the local server."
      : "Saved, but the server didn't accept it. Is `npm run ia -- serve` running?";
  });
});
