import type { FieldResult } from "@ia/adapters";
import type { PageFieldInfo, SessionState, TabJob } from "./session.ts";

/** Messages the side panel and content scripts send to the background worker. */
export type ToBackground =
  | { type: "session:start" }
  | { type: "session:skip" }
  | { type: "session:confirm" }
  | { type: "session:end" }
  | { type: "session:get" }
  | { type: "content:ready"; url: string }
  | { type: "content:filled"; results: FieldResult[]; snapshotHtml: string | null }
  | { type: "content:confirmed"; url: string }
  | { type: "content:error"; message: string }
  | { type: "content:map"; fields: PageFieldInfo[] }
  | { type: "session:inject" };

export type ContentReadyReply = TabJob;

/** Broadcast from the background worker whenever the session changes. */
export interface StateBroadcast {
  type: "state";
  state: SessionState;
}
