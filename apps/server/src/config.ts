import { join, resolve } from "node:path";

export interface Paths {
  home: string;
  db: string;
  out: string;
  snapshots: string;
  profile: string;
}

/** Everything personal lives under IA_HOME (default ./data, gitignored) plus profile.yaml. */
export function resolvePaths(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Paths {
  const home = resolve(cwd, env.IA_HOME ?? "data");
  return {
    home,
    db: join(home, "ia.sqlite"),
    out: join(home, "out"),
    snapshots: join(home, "snapshots"),
    profile: resolve(cwd, env.IA_PROFILE ?? "profile.yaml"),
  };
}

export const DEFAULT_PORT = 4317;
export const HOST = "127.0.0.1";
