import { ashby, greenhouse, lever } from "./platforms.ts";
import { icims, smartrecruiters, workday } from "./platforms2.ts";
import type { Adapter } from "./types.ts";

export * from "./dom.ts";
export * from "./engine.ts";
export * from "./platforms.ts";
export * from "./platforms2.ts";
export * from "./safe-click.ts";
export * from "./types.ts";

/** Adapters in the order they are tried. Later phases add to this list. */
export const ADAPTERS: Adapter[] = [greenhouse, lever, ashby, workday, smartrecruiters, icims];

export function registerAdapter(a: Adapter, opts: { last?: boolean } = {}): void {
  if (ADAPTERS.some((x) => x.id === a.id)) return;
  if (opts.last) ADAPTERS.push(a);
  else ADAPTERS.splice(ADAPTERS.length, 0, a);
}

export function pickAdapter(url: URL, doc: Document): Adapter | null {
  return ADAPTERS.find((a) => a.matches(url, doc)) ?? null;
}
