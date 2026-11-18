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

/** An approved application whose posting closed before the session reached it. */
export interface ClosedSkip {
  id: number;
  company: string;
  title: string;
  reason: string;
}

export type NextResponse =
  | { done: true; remaining: 0; closed?: ClosedSkip[] }
  | { done: false; remaining: number; application: SessionApplication; closed?: ClosedSkip[] };

export interface Mismatch {
  key: string;
  label: string;
  planned: string | null;
  seen: string | null;
}

/** A field on a page no adapter knows, as the generic adapter lists it. */
export interface PageFieldInfo {
  key: string;
  label: string;
  type: string;
  required: boolean;
  options?: string[];
}

export type MappedField = FillField & { via: "same_label" | "profile_field" | "model" | "none" };

/** Career sites the content script runs on by itself. Anything else needs your OK first. */
export const SUPPORTED_HOSTS =
  /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|myworkdaysite\.com|smartrecruiters\.com|icims\.com)$/;

export function isSupportedUrl(url: string): boolean {
  try {
    return SUPPORTED_HOSTS.test(new URL(url).hostname);
  } catch {
    return false;
  }
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
  mapFields(id: number, fields: PageFieldInfo[]): Promise<{ fields: MappedField[] }>;
  /** The application you chose with "Open & fill" in the review UI, if this page is its site. */
  launch?(url: string): Promise<{ application: SessionApplication | null }>;
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
  /** The page isn't a known career site: the generic filler needs your OK for this site. */
  needsGeneric: boolean;
  /** Approved applications skipped this session because the posting closed. */
  closedSkipped: ClosedSkip[];
  /** Opened with "Open & fill" in the review UI: just this one, never the next approved. */
  single?: boolean;
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
  needsGeneric: false,
  closedSkipped: [],
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
      const closedNow = next.closed ?? [];
      const closedSkipped = [...(this.state.closedSkipped ?? []), ...closedNow];
      const closedNote = closedNow.length
        ? `Skipped ${closedNow.length} that closed since you approved ${closedNow.length === 1 ? "it" : "them"}: ${closedNow.map((c) => c.company).join(", ")}.`
        : null;
      if (next.done) {
        this.current = null;
        this.set({
          phase: "done",
          application: null,
          remaining: 0,
          closedSkipped,
          message: [closedNote, "No approved applications left."].filter(Boolean).join(" "),
        });
        return;
      }
      this.current = next.application;
      this.snapshot = null;
      const { files: _files, ...summary } = next.application;
      const tabId = await this.deps.openTab(next.application.applyUrl, this.state.tabId);
      const known = isSupportedUrl(next.application.applyUrl);
      this.set({
        phase: "filling",
        tabId,
        application: summary,
        remaining: next.remaining,
        needsGeneric: !known,
        closedSkipped,
        message:
          [
            closedNote,
            known
              ? null
              : "This site isn't one the extension knows. Press “Fill this page” to allow it for this site and try the generic filler, or fill it by hand.",
          ]
            .filter(Boolean)
            .join(" ") || null,
      });
    } catch (e) {
      this.set({ phase: "error", message: `Couldn't reach the local server: ${String(e)}` });
    }
  }

  /**
   * A page loaded in a tab the session didn't open. If you just pressed "Open & fill" in the
   * review UI for this site, adopt the tab and fill it. A running session is never interrupted.
   */
  async jobForPage(tabId: number, url: string): Promise<TabJob> {
    const job = this.jobForTab(tabId);
    if (job || !this.deps.api.launch) return job;
    if (this.state.phase === "filling" || this.state.phase === "waiting_for_you") return null;
    if (this.state.phase === "loading") return null;
    let launched: SessionApplication | null;
    try {
      launched = (await this.deps.api.launch(url)).application;
    } catch {
      return null; // server not running or no token: nothing to adopt
    }
    if (!launched) return null;
    this.current = launched;
    this.snapshot = null;
    const { files: _files, ...summary } = launched;
    this.set({
      ...IDLE,
      submittedCount: this.state.submittedCount,
      phase: "filling",
      tabId,
      application: summary,
      remaining: 0,
      single: true,
      message: "Opened from the review UI.",
    });
    return { mode: "fill", application: launched };
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
      if (this.state.single) return this.stopSingle("Recorded as submitted.");
      await this.advance();
    } catch (e) {
      this.set({ phase: "error", message: String(e) });
    }
  }

  /** Generic filler: map the page's fields to the plan (values come only from the plan). */
  async mapFields(tabId: number, fields: PageFieldInfo[]): Promise<MappedField[]> {
    if (tabId !== this.state.tabId || !this.current) return [];
    const { fields: mapped } = await this.deps.api.mapFields(this.current.id, fields);
    this.set({
      needsGeneric: false,
      message: "Generic fill on an unfamiliar site: check every field before you submit.",
    });
    return mapped;
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
    if (this.state.single) return this.stopSingle("Left as approved.");
    this.set({ skip: [...this.state.skip, app.id] });
    await this.advance();
  }

  /** A single "Open & fill" is over: stop here instead of opening the next approved one. */
  private stopSingle(what: string): void {
    this.current = null;
    this.set({
      ...IDLE,
      phase: "done",
      submittedCount: this.state.submittedCount,
      message: `${what} Open the next one from the review UI, or start a session here.`,
    });
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
