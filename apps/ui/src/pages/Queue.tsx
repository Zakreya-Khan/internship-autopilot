import { useCallback, useEffect, useState } from "react";
import type { QueueItem } from "../api.ts";
import { api, changed } from "../api.ts";
import { JobStatus, useJob } from "../components/Jobs.tsx";
import { OpenFill } from "../components/OpenFill.tsx";
import { STATUS_LABEL } from "../labels.ts";

const TABS = [
  { key: null, label: "All" },
  { key: "needs_input", label: "Needs input" },
  { key: "ready", label: "Ready" },
  { key: "approved", label: "Approved" },
  { key: "filled", label: "Filled" },
] as const;
/** Work in the order you'd do it: ready to approve first, then what needs you. */
const ORDER = ["ready", "needs_input", "approved", "filled"];

/** Typing in a field never triggers a shortcut. */
export function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return (
    Boolean(
      typeof t?.closest === "function" && t.closest("input, textarea, select, [contenteditable]"),
    ) ||
    e.metaKey ||
    e.ctrlKey ||
    e.altKey
  );
}

export function Queue({ status }: { status: string | null }) {
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api
        .queue()
        .then((x) => {
          setItems(x);
          setError(null);
        })
        .catch((e: Error) => setError(e.message)),
    [],
  );
  useEffect(() => {
    void load();
    window.addEventListener("ia:changed", load);
    return () => window.removeEventListener("ia:changed", load);
  }, [load]);
  const prep = useJob("prep", () => void load());

  const shown = (items ?? [])
    .filter((i) => !status || i.status === status)
    .sort(
      (a, b) =>
        ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || (b.score ?? 0) - (a.score ?? 0),
    );

  const act = useCallback(
    async (i: QueueItem, to: "approved" | "skipped" | "parked") => {
      try {
        await api.setStatus(i.id, to);
        setNote(
          `${i.posting.company}: ${to === "approved" ? "approved" : to === "skipped" ? "skipped" : "parked"}.`,
        );
        changed();
        await load();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [load],
  );

  // j/k move, a approve, s skip, p park, Enter open.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (typing(e) || !shown.length) return;
      const i = shown[Math.min(cursor, shown.length - 1)]!;
      if (e.key === "j" || e.key === "ArrowDown")
        setCursor((c) => Math.min(c + 1, shown.length - 1));
      else if (e.key === "k" || e.key === "ArrowUp") setCursor((c) => Math.max(c - 1, 0));
      else if (e.key === "a" && i.status === "ready") void act(i, "approved");
      else if (e.key === "s") void act(i, "skipped");
      else if (e.key === "p") void act(i, "parked");
      else if (e.key === "Enter") window.location.hash = `#/app/${i.id}`;
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [shown, cursor, act]);

  if (error && !items) return <p role="alert">Couldn't load the queue: {error}</p>;
  if (!items) return <p>Loading the queue…</p>;
  const count = (k: string | null) =>
    k ? items.filter((i) => i.status === k).length : items.length;
  return (
    <section>
      <header className="row">
        <h1>Review queue</h1>
        <div className="actions">
          <button disabled={prep.running} onClick={() => void prep.start({ limit: 5 })}>
            {prep.running ? "Preparing…" : "Prepare 5 more"}
          </button>
        </div>
      </header>
      <JobStatus job={prep.job} error={prep.error} onCancel={() => void prep.cancel()} />
      <div className="tabs" role="tablist" aria-label="Show">
        {TABS.map((t) => (
          <a
            key={t.label}
            role="tab"
            aria-selected={status === t.key}
            className="tab"
            href={t.key ? `#/queue/${t.key}` : "#/queue"}
          >
            {t.label} ({count(t.key)})
          </a>
        ))}
      </div>
      <p className="muted small">
        Approve what's ready, then Open &amp; fill: the extension fills the page and you press
        Submit. Keys: <kbd>j</kbd>/<kbd>k</kbd> move, <kbd>a</kbd> approve, <kbd>s</kbd> skip,{" "}
        <kbd>p</kbd> park, <kbd>Enter</kbd> open.
      </p>
      {note ? <p role="status">{note}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {shown.length === 0 ? (
        <div className="empty panel">
          {items.length === 0 ? (
            <>
              <h2>Nothing prepared yet</h2>
              <p>
                Prepare tailors a resume and answers for your best postings. Or pick postings
                yourself in <a href="#/discover">Discover</a>.
              </p>
              <button disabled={prep.running} onClick={() => void prep.start({ limit: 5 })}>
                Prepare 5
              </button>
            </>
          ) : status === "approved" ? (
            <p>
              Nothing approved. Approve applications on the <a href="#/queue/ready">Ready</a> tab.
            </p>
          ) : status === "ready" ? (
            <p>
              Nothing ready to approve. <a href="#/questions">Answer open questions</a> to move
              applications along.
            </p>
          ) : (
            <p>Nothing here.</p>
          )}
        </div>
      ) : (
        <table className="queue">
          <thead>
            <tr>
              <th scope="col">Company</th>
              <th scope="col">Role</th>
              <th scope="col">Tier</th>
              <th scope="col">Fit</th>
              <th scope="col">Deadline</th>
              <th scope="col">Status</th>
              <th scope="col">Flags</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((i, n) => (
              <tr
                key={i.id}
                aria-selected={n === Math.min(cursor, shown.length - 1)}
                onClick={() => setCursor(n)}
              >
                <td>{i.posting.company}</td>
                <td>
                  <a href={`#/app/${i.id}`}>{i.posting.title}</a>
                </td>
                <td>{i.tier}</td>
                <td>{i.score ?? "–"}</td>
                <td>{i.posting.deadline ?? "rolling"}</td>
                <td>{STATUS_LABEL[i.status] ?? i.status}</td>
                <td>
                  {i.flags.red ? (
                    <span className="flag flag-red">{i.flags.red} need you</span>
                  ) : null}{" "}
                  {i.flags.amber ? (
                    <span className="flag flag-amber">{i.flags.amber} check</span>
                  ) : null}
                </td>
                <td className="actions">
                  {i.status === "ready" ? (
                    <button onClick={() => void act(i, "approved")}>Approve</button>
                  ) : null}
                  {i.status === "approved" ? (
                    <OpenFill id={i.id} company={i.posting.company} />
                  ) : null}
                  {i.status === "needs_input" ? (
                    <a className="button" href={`#/app/${i.id}`}>
                      Fill in
                    </a>
                  ) : null}
                  <button className="quiet" onClick={() => void act(i, "skipped")}>
                    Skip
                  </button>
                  {i.status !== "filled" ? (
                    <button className="quiet" onClick={() => void act(i, "parked")}>
                      Park
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
