import { useCallback, useEffect, useState } from "react";
import type { Summary } from "./api.ts";
import { api } from "./api.ts";
import { Answers } from "./pages/Answers.tsx";
import { DetailPage } from "./pages/DetailPage.tsx";
import { Discover } from "./pages/Discover.tsx";
import { Home } from "./pages/Home.tsx";
import { Questions } from "./pages/Questions.tsx";
import { Qualify } from "./pages/Qualify.tsx";
import { Queue } from "./pages/Queue.tsx";
import { Settings } from "./pages/Settings.tsx";
import { Stats } from "./pages/Stats.tsx";
import { Tools } from "./pages/Tools.tsx";
import { Tracker } from "./pages/Tracker.tsx";

type Route =
  | { page: "home" }
  | { page: "discover" }
  | { page: "queue"; status: string | null }
  | { page: "detail"; id: number }
  | { page: "tracker" }
  | { page: "stats" }
  | { page: "qualify" }
  | { page: "questions" }
  | { page: "answers" }
  | { page: "tools" }
  | { page: "settings" };

export function parseRoute(hash: string): Route {
  const m = /^#\/app\/(\d+)/.exec(hash);
  if (m) return { page: "detail", id: Number(m[1]) };
  const q = /^#\/queue(?:\/(\w+))?/.exec(hash);
  if (q) return { page: "queue", status: q[1] ?? null };
  for (const page of [
    "discover",
    "tracker",
    "stats",
    "qualify",
    "settings",
    "questions",
    "answers",
    "tools",
  ] as const)
    if (hash.startsWith(`#/${page}`)) return { page };
  return { page: "home" };
}

/** Counts for the nav, refreshed as you work (and while a background job runs). */
function useSummary(): Summary | null {
  const [s, setS] = useState<Summary | null>(null);
  const load = useCallback(
    () =>
      void api
        .summary()
        .then(setS)
        .catch(() => setS(null)),
    [],
  );
  useEffect(() => {
    load();
    const events = ["hashchange", "ia:changed", "ia:questions-changed"];
    for (const e of events) window.addEventListener(e, load);
    return () => {
      for (const e of events) window.removeEventListener(e, load);
    };
  }, [load]);
  const busy = Boolean(s?.jobs.length);
  useEffect(() => {
    const t = setInterval(load, busy ? 2000 : 30000);
    return () => clearInterval(t);
  }, [load, busy]);
  return s;
}

function Count({ n, label, tone }: { n: number | undefined; label: string; tone?: "quiet" }) {
  if (!n) return null;
  return (
    <span className={`count ${tone === "quiet" ? "count-quiet" : ""}`} aria-label={`${n} ${label}`}>
      {n}
    </span>
  );
}

export function App() {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parseRoute(window.location.hash));
      window.scrollTo(0, 0); // a new page starts at the top
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const s = useSummary();
  const here = (page: Route["page"]) => (route.page === page ? "page" : undefined);
  const job = s?.jobs[0];
  return (
    <>
      <nav aria-label="Main">
        <a href="#/" className="brand" aria-current={here("home")}>
          Internship Autopilot
        </a>
        <a href="#/discover" aria-current={here("discover")}>
          Discover
        </a>
        <a
          href="#/queue"
          aria-current={route.page === "queue" || route.page === "detail" ? "page" : undefined}
        >
          Queue
          <Count n={(s?.ready ?? 0) + (s?.needsInput ?? 0)} label="to review" tone="quiet" />
        </a>
        <a href="#/questions" aria-current={here("questions")}>
          Questions
          <Count n={s?.questions} label="unanswered" />
        </a>
        <a href="#/queue/approved" className="nav-fill">
          Ready to fill
          <Count n={(s?.approved ?? 0) + (s?.filled ?? 0)} label="approved" tone="quiet" />
        </a>
        <a href="#/tracker" aria-current={here("tracker")}>
          Tracker
        </a>
        <span className="nav-more">
          <a href="#/answers" aria-current={here("answers")}>
            Answers
          </a>
          <a href="#/qualify" aria-current={here("qualify")}>
            Qualify
          </a>
          <a href="#/stats" aria-current={here("stats")}>
            Stats
          </a>
          <a href="#/tools" aria-current={here("tools")}>
            Tools
          </a>
          <a href="#/settings" aria-current={here("settings")}>
            Settings
          </a>
        </span>
        {job ? (
          <a href="#/tools" className="nav-job" role="status">
            {job.label}
            {job.progress?.total
              ? ` ${Math.round((job.progress.done / job.progress.total) * 100)}%`
              : "…"}
          </a>
        ) : null}
      </nav>
      <p className="rule small muted">Nothing here submits. You press each site's Submit button.</p>
      <main>
        {route.page === "home" ? <Home /> : null}
        {route.page === "discover" ? <Discover /> : null}
        {route.page === "queue" ? <Queue status={route.status} /> : null}
        {route.page === "detail" ? <DetailPage id={route.id} /> : null}
        {route.page === "tracker" ? <Tracker /> : null}
        {route.page === "stats" ? <Stats /> : null}
        {route.page === "qualify" ? <Qualify /> : null}
        {route.page === "settings" ? <Settings /> : null}
        {route.page === "questions" ? <Questions /> : null}
        {route.page === "answers" ? <Answers /> : null}
        {route.page === "tools" ? <Tools /> : null}
      </main>
    </>
  );
}
