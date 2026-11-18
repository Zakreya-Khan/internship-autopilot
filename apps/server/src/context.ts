import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { loadProfile } from "@ia/core";
import type { Profile } from "@ia/core";
import { AnthropicLlm, hasAnthropicCredentials } from "@ia/ai";
import type { LlmClient } from "@ia/ai";
import type { Paths } from "./config.ts";
import { resolvePaths } from "./config.ts";
import { Store } from "./db.ts";

export interface AppContext {
  paths: Paths;
  store: Store;
  profile: Profile;
  llm: LlmClient | null;
  token: string;
}

/** The token the extension and UI must send. Created once per install, stored in the DB. */
export function ensureToken(store: Store): string {
  let t = store.getMeta("api_token");
  if (!t) {
    t = randomBytes(24).toString("base64url");
    store.setMeta("api_token", t);
  }
  return t;
}

export function openContext(opts: { offline?: boolean; env?: NodeJS.ProcessEnv } = {}): AppContext {
  const paths = resolvePaths(opts.env);
  if (!existsSync(paths.profile)) {
    throw new Error(`No profile at ${paths.profile}. Run "npm run ia -- init" and fill it in.`);
  }
  const profile = loadProfile(paths.profile);
  const store = new Store(paths.db);
  const useModel = !opts.offline && hasAnthropicCredentials(opts.env);
  const llm = useModel
    ? new AnthropicLlm(undefined, ({ purpose, model, usage }) =>
        store.logLlmCall(purpose, model, usage),
      )
    : null;
  return { paths, store, profile, llm, token: ensureToken(store) };
}
