import type { MappedField, Mismatch, NextResponse, SessionApi } from "./session.ts";

export interface ServerConfig {
  baseUrl: string;
  token: string;
}

export const DEFAULT_BASE_URL = "http://127.0.0.1:4317";

export async function loadConfig(): Promise<ServerConfig> {
  const got = (await chrome.storage.local.get(["baseUrl", "token"])) as Partial<ServerConfig>;
  return { baseUrl: got.baseUrl || DEFAULT_BASE_URL, token: got.token || "" };
}

export function makeApi(
  getConfig: () => Promise<ServerConfig>,
  fetchFn: typeof fetch = fetch,
): SessionApi {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const { baseUrl, token } = await getConfig();
    if (!token) throw new Error("Set the token in the extension's options first.");
    const res = await fetchFn(`${baseUrl}${path}`, {
      method,
      headers: { "x-ia-token": token, "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  };
  return {
    next: (skip) => call<NextResponse>("POST", "/api/session/next", { skip }),
    filled: (id, seen) =>
      call<{ mismatches: Mismatch[] }>("POST", `/api/applications/${id}/filled`, { seen }),
    submitted: async (id, body) => {
      await call("POST", `/api/applications/${id}/submitted`, body);
    },
    abandon: async (id) => {
      await call("POST", `/api/applications/${id}/abandon`);
    },
    mapFields: (id, fields) =>
      call<{ fields: MappedField[] }>("POST", `/api/applications/${id}/map-fields`, { fields }),
  };
}
