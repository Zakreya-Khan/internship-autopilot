import { useEffect, useState } from "react";
import type { QueueItem } from "../api.ts";
import { api } from "../api.ts";

const STATUS_LABEL: Record<string, string> = {
  needs_input: "Needs input",
  ready: "Ready",
  approved: "Approved",
  filled: "Filled",
};

export function Queue() {
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");

  const load = () =>
    api
      .queue()
      .then(setItems)
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  const act = async (id: number, to: "approved" | "skipped" | "parked") => {
    try {
      await api.setStatus(id, to);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (error) return <p role="alert">{error}</p>;
  if (!items) return <p>Loading…</p>;
  const shown = filter === "all" ? items : items.filter((i) => i.status === filter);
  return (
    <section>
      <header className="row">
        <h1>Review queue</h1>
        <label>
          Show{" "}
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">All ({items.length})</option>
            {Object.entries(STATUS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v} ({items.filter((i) => i.status === k).length})
              </option>
            ))}
          </select>
        </label>
      </header>
      <p className="muted">
        Approve what's ready, then start a submit session from the browser extension. You press each
        site's Submit button yourself.
      </p>
      {shown.length === 0 ? (
        <p>Nothing here. Run `npm run ia -- prep` to prepare more.</p>
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
            {shown.map((i) => (
              <tr key={i.id}>
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
                    <button onClick={() => void act(i.id, "approved")}>Approve</button>
                  ) : null}
                  <button className="quiet" onClick={() => void act(i.id, "skipped")}>
                    Skip
                  </button>
                  <button className="quiet" onClick={() => void act(i.id, "parked")}>
                    Park
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
