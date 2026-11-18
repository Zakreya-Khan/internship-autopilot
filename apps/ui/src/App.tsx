import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { Answers } from "./pages/Answers.tsx";
import { DetailPage } from "./pages/DetailPage.tsx";
import { Questions } from "./pages/Questions.tsx";
import { Qualify } from "./pages/Qualify.tsx";
import { Queue } from "./pages/Queue.tsx";
import { Settings } from "./pages/Settings.tsx";
import { Stats } from "./pages/Stats.tsx";
import { Tracker } from "./pages/Tracker.tsx";

type Route =
  | { page: "queue" }
  | { page: "detail"; id: number }
  | { page: "tracker" }
  | { page: "stats" }
  | { page: "qualify" }
  | { page: "questions" }
  | { page: "answers" }
  | { page: "settings" };

export function parseRoute(hash: string): Route {
  const m = /^#\/app\/(\d+)/.exec(hash);
  if (m) return { page: "detail", id: Number(m[1]) };
  if (hash.startsWith("#/tracker")) return { page: "tracker" };
  if (hash.startsWith("#/stats")) return { page: "stats" };
  if (hash.startsWith("#/qualify")) return { page: "qualify" };
  if (hash.startsWith("#/settings")) return { page: "settings" };
  if (hash.startsWith("#/questions")) return { page: "questions" };
  if (hash.startsWith("#/answers")) return { page: "answers" };
  return { page: "queue" };
}

export function App() {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  // Unanswered questions across every pending application, for the nav badge.
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    const count = () =>
      void api
        .questionCount()
        .then((r) => setOpen(r.count))
        .catch(() => setOpen(null));
    count();
    window.addEventListener("hashchange", count);
    window.addEventListener("ia:questions-changed", count);
    return () => {
      window.removeEventListener("hashchange", count);
      window.removeEventListener("ia:questions-changed", count);
    };
  }, []);
  return (
    <>
      <nav aria-label="Main">
        <strong>Internship Autopilot</strong>
        <a href="#/" aria-current={route.page === "queue" ? "page" : undefined}>
          Queue
        </a>
        <a href="#/questions" aria-current={route.page === "questions" ? "page" : undefined}>
          Questions
          {open ? (
            <span className="count" aria-label={`${open} unanswered`}>
              {open}
            </span>
          ) : null}
        </a>
        <a href="#/answers" aria-current={route.page === "answers" ? "page" : undefined}>
          Answers
        </a>
        <a href="#/qualify" aria-current={route.page === "qualify" ? "page" : undefined}>
          Qualify
        </a>
        <a href="#/tracker" aria-current={route.page === "tracker" ? "page" : undefined}>
          Tracker
        </a>
        <a href="#/stats" aria-current={route.page === "stats" ? "page" : undefined}>
          Stats
        </a>
        <a href="#/settings" aria-current={route.page === "settings" ? "page" : undefined}>
          Settings
        </a>
        <span className="muted small">
          Nothing here submits. You press each site's Submit button.
        </span>
      </nav>
      <main>
        {route.page === "queue" ? <Queue /> : null}
        {route.page === "detail" ? <DetailPage id={route.id} /> : null}
        {route.page === "tracker" ? <Tracker /> : null}
        {route.page === "stats" ? <Stats /> : null}
        {route.page === "qualify" ? <Qualify /> : null}
        {route.page === "settings" ? <Settings /> : null}
        {route.page === "questions" ? <Questions /> : null}
        {route.page === "answers" ? <Answers /> : null}
      </main>
    </>
  );
}
