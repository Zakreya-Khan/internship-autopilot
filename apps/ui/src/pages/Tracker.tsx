import { useEffect, useState } from "react";
import type { ApplicationStatus } from "@ia/core";
import type { TrackerRow } from "../api.ts";
import { api } from "../api.ts";

const OUTCOMES: ApplicationStatus[] = [
  "submitted",
  "online_assessment",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
  "no_response",
];

export function Tracker() {
  const [rows, setRows] = useState<TrackerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    api
      .tracker()
      .then(setRows)
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  const guard = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!rows) return error ? <p role="alert">{error}</p> : <p>Loading…</p>;
  return (
    <section>
      <header className="row">
        <h1>Tracker</h1>
      </header>
      {error ? <p role="alert">{error}</p> : null}
      {rows.length === 0 ? (
        <p>No submitted applications yet.</p>
      ) : (
        <table className="queue">
          <thead>
            <tr>
              <th scope="col">Company</th>
              <th scope="col">Role</th>
              <th scope="col">Submitted</th>
              <th scope="col">Status</th>
              <th scope="col">Next action</th>
              <th scope="col">Due</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.posting.company}</td>
                <td>
                  <a href={`#/app/${r.id}`}>{r.posting.title}</a>
                </td>
                <td>{r.submitted_at?.slice(0, 10) ?? "–"}</td>
                <td>
                  <select
                    aria-label={`Status for ${r.posting.company}`}
                    value={r.status}
                    onChange={(e) =>
                      void guard(() => api.setStatus(r.id, e.target.value as ApplicationStatus))
                    }
                  >
                    {OUTCOMES.map((s) => (
                      <option
                        key={s}
                        value={s}
                        disabled={s === "submitted" && r.status !== "submitted"}
                      >
                        {s.replace("_", " ")}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    aria-label={`Next action for ${r.posting.company}`}
                    defaultValue={r.next_action ?? ""}
                    onBlur={(e) =>
                      void guard(() =>
                        api.setTracking(r.id, { next_action: e.target.value || null }),
                      )
                    }
                  />
                </td>
                <td>
                  <input
                    type="date"
                    aria-label={`Due date for ${r.posting.company}`}
                    defaultValue={r.next_action_due ?? ""}
                    onChange={(e) =>
                      void guard(() =>
                        api.setTracking(r.id, { next_action_due: e.target.value || null }),
                      )
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
