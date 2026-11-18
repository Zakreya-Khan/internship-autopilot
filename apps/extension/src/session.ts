import type { FieldResult, FillField } from "@ia/adapters";

export interface SessionApplication {
  id: number;
  applyUrl: string;
  ats: string;
  company: string;
  title: string;
  fields: (FillField & { flag?: string | null; note?: string | null })[];
  files: Partial<Record<"resume" | "cover_letter", { name: string; base64: string }>>;
}

export type NextResponse =
  | { done: true; remaining: 0 }
  | { done: false; remaining: number; application: SessionApplication };

export interface Mismatch {
  key: string;
  label: string;
  planned: string | null;
  seen: string | null;
}

export interface SessionApi {
  next(skip: number[]): Promise<NextResponse>;
  filled(id: number, seen: Record<string, string | null>): Promise<{ mismatches: Mismatch[] }>;
  submitted(
    id: number,
    body: {
      detectedBy: "confirmation_page" | "user";
      confirmationUrl?: string;
      snapshotHtml?: string;
    },
  ): Promise<void>;
  abandon(id: number): Promise<void>;
}

export type Phase = "idle" | "loading" | "filling" | "waiting_for_you" | "done" | "error";

export interface SessionState {
  phase: Phase;
  tabId: number | null;
  application: Omit<SessionApplication, "files"> | null;
  remaining: number;
  skip: number[];
  submittedCount: number;
  mismatches: Mismatch[];
  problems: FieldResult[];
  message: string | null;
}

export const IDLE: SessionState = {
  phase: "idle",
  tabId: null,
  application: null,
  remaining: 0,
  skip: [],
  submittedCount: 0,
  mismatches: [],
  problems: [],
  message: null,
};

export interface SessionDeps {
  api: SessionApi;
  /** Open (or reuse) a tab at a URL; returns its id. */
  openTab(url: string, reuseTabId: number | null): Promise<number>;
  onChange(state: SessionState): void;
}

/** What the content script in a tab should do. */
export type TabJob =
  | { mode: "fill"; application: SessionApplication }
  | { mode: "watch"; applicationId: number }
  | null;

/**
 * The submit session: one approved application at a time, filled in its own tab, waiting
 * for you to press the site's Submit. It advances only after the confirmation page is seen
 * or you say it went through. It has no way to submit anything itself.
 */
export class SessionController {
  private state: SessionState = { ...IDLE };
  private current: SessionApplication | null = null;
  private snapshot: string | null = null;

  constructor(private readonly deps: SessionDeps) {}

  get(): SessionState {
    return this.state;
  }

  restore(state: SessionState, current: SessionApplication | null): void {
    this.state = state;
    this.current = current;
  }

  currentApplication(): SessionApplication | null {
    return this.current;
  }

  private set(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    this.deps.onChange(this.state);
  }

  async start(): Promise<void> {
    this.set({ ...IDLE, phase: "loading" });
    await this.advance();
  }

  private async advance(): Promise<void> {
    this.set({ phase: "loading", mismatches: [], problems: [], message: null });
    try {
      const next = await this.deps.api.next(this.state.skip);
      if (next.done) {
        this.current = null;
        this.set({
          phase: "done",
          application: null,
          remaining: 0,
          message: "No approved applications left.",
        });
        return;
      }
      this.current = next.application;
      this.snapshot = null;
      const { files: _files, ...summary } = next.application;
      const tabId = await this.deps.openTab(next.application.applyUrl, this.state.tabId);
      this.set({ phase: "filling", tabId, application: summary, remaining: next.remaining });
    } catch (e) {
      this.set({ phase: "error", message: `Couldn't reach the local server: ${String(e)}` });
    }
  }

  /** Called by a content script when its page loads. */
  jobForTab(tabId: number): TabJob {
    if (tabId !== this.state.tabId || !this.current) return null;
    if (this.state.phase === "filling") return { mode: "fill", application: this.current };
    if (this.state.phase === "waiting_for_you")
      return { mode: "watch", applicationId: this.current.id };
    return null;
  }

  async onFilled(
    tabId: number,
    results: FieldResult[],
    snapshotHtml: string | null,
  ): Promise<void> {
    if (tabId !== this.state.tabId || !this.current) return;
    this.snapshot = snapshotHtml;
    const seen = Object.fromEntries(
      results.filter((r) => r.status !== "not_found").map((r) => [r.key, r.seen]),
    );
    const problems = results.filter((r) => r.status === "not_found" || r.status === "failed");
    try {
      const { mismatches } = await this.deps.api.filled(this.current.id, seen);
      this.set({
        phase: "waiting_for_you",
        mismatches,
        problems,
        message: "Check the page, solve any CAPTCHA, then press the site's Submit button yourself.",
      });
    } catch (e) {
      this.set({ phase: "error", message: String(e) });
    }
  }

  /** The content script saw the site's confirmation page. */
  async onConfirmed(tabId: number, url: string): Promise<void> {
    if (tabId !== this.state.tabId || !this.current || this.state.phase !== "waiting_for_you")
      return;
    await this.finish({ detectedBy: "confirmation_page", confirmationUrl: url });
  }

  /** You say it went through (no confirmation page was recognized). */
  async confirmByUser(): Promise<void> {
    if (!this.current || this.state.phase !== "waiting_for_you") return;
    await this.finish({ detectedBy: "user" });
  }

  private async finish(body: {
    detectedBy: "confirmation_page" | "user";
    confirmationUrl?: string;
  }): Promise<void> {
    const app = this.current!;
    try {
      await this.deps.api.submitted(app.id, {
        ...body,
        ...(this.snapshot ? { snapshotHtml: this.snapshot } : {}),
      });
      this.set({ submittedCount: this.state.submittedCount + 1 });
      await this.advance();
    } catch (e) {
      this.set({ phase: "error", message: String(e) });
    }
  }

  /** A message from the page (sign-in needed, a step needs you). Shown in the side panel. */
  note(tabId: number, message: string): void {
    if (tabId === this.state.tabId) this.set({ message });
  }

  /** Not this one now: put it back to Approved and move on. */
  async skip(): Promise<void> {
    const app = this.current;
    if (!app) return;
    try {
      if (this.state.phase === "waiting_for_you") await this.deps.api.abandon(app.id);
    } catch {
      /* already back to approved */
    }
    this.set({ skip: [...this.state.skip, app.id] });
    await this.advance();
  }

  async end(): Promise<void> {
    const app = this.current;
    if (app && this.state.phase === "waiting_for_you") {
      try {
        await this.deps.api.abandon(app.id);
      } catch {
        /* ignore */
      }
    }
    this.current = null;
    this.set({ ...IDLE, submittedCount: this.state.submittedCount, message: "Session ended." });
  }
}
