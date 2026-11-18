import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { loadProfile, readCoverLetterBase, voiceFromSamples } from "@ia/core";
import type { CoverLetterBase, Profile, VoiceTraits } from "@ia/core";
import type { LlmClient } from "@ia/ai";
import type { Paths } from "./config.ts";
import { resolvePaths } from "./config.ts";
import { Store } from "./db.ts";
import type { Provider } from "./provider.ts";
import { buildLlm } from "./provider.ts";

export interface AppContext {
  paths: Paths;
  store: Store;
  profile: Profile;
  llm: LlmClient | null;
  /** Which provider is in use: the saved choice, or the --provider flag. */
  provider: Provider;
  /** Why there is no model (no key, no CLI, or --offline), when llm is null. */
  llmReason: string | null;
  token: string;
  /** Measured from style.writing_samples, if any. Numbers only. */
  voice: VoiceTraits | null;
  /** Your own cover letter, from style.cover_letter_base, if set. */
  coverBase: CoverLetterBase | null;
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

export function openContext(
  opts: { offline?: boolean; env?: NodeJS.ProcessEnv; provider?: Provider | null } = {},
): AppContext {
  const paths = resolvePaths(opts.env);
  if (!existsSync(paths.profile)) {
    throw new Error(`No profile at ${paths.profile}. Run "npm run ia -- init" and fill it in.`);
  }
  const profile = loadProfile(paths.profile);
  const store = new Store(paths.db);
  const choice = buildLlm({
    store,
    paths,
    env: opts.env ?? process.env,
    override: opts.provider ?? null,
  });
  const llm = opts.offline ? null : choice.llm;
  const llmReason = opts.offline ? "--offline" : choice.reason;
  const voice = voiceFromSamples(profile.style.writing_samples, paths.profile);
  const coverBase = readCoverLetterBase(profile.style.cover_letter_base, paths.profile);
  return {
    paths,
    store,
    profile,
    llm,
    provider: choice.provider,
    llmReason,
    token: ensureToken(store),
    voice,
    coverBase,
  };
}
