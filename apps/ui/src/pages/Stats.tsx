import { useEffect, useState } from "react";
import type { Stats as StatsData } from "../api.ts";
import { api } from "../api.ts";

const pct = (x: number) => `${Math.round(x * 100)}%`;

function RateTable({ title, rows }: { title: string; rows: StatsData["byTier"] }) {
  if (!rows.length) return null;
  return (
    <section className="panel">
      <h2>{title}</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Group</th>
            <th scope="col">Sent</th>
            <th scope="col">Any reply</th>
            <th scope="col">Assessment, interview or offer</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.key}</td>
              <td>{r.submitted}</td>
              <td>{pct(r.rate)}</td>
              <td>{pct(r.positiveRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function Stats() {
  const [s, setS] = useState<StatsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    api
      .stats()
      .then(setS)
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  if (!s) return error ? <p role="alert">{error}</p> : <p>Loading…</p>;
  const spend = s.cost.filter((c) => c.provider !== "cli").reduce((a, c) => a + c.usd, 0);
  const cliCalls = s.cost.filter((c) => c.provider === "cli").reduce((a, c) => a + c.calls, 0);
  return (
    <section>
      <h1>Outcomes</h1>
      <p className="muted">
        {s.totals.sent ?? 0} sent · API spend so far ${spend.toFixed(2)}
        {cliCalls
          ? ` · ${cliCalls} calls through the Claude CLI, covered by your subscription`
          : ""}
        . Use the score bands to decide whether the Tier B threshold is right: if low bands reply as
        often as high ones, prepare more; if they don't, prepare fewer.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {s.suggestions.length ? (
        <section className="panel">
          <h2>Suggestions</h2>
          <ul>
            {s.suggestions.map((x) => (
              <li key={`${x.kind}-${x.applicationId}`}>
                {x.text}{" "}
                {x.kind === "mark_no_response" ? (
                  <button
                    className="quiet"
                    onClick={() =>
                      void api
                        .setStatus(x.applicationId, "no_response")
                        .then(load)
                        .catch((e: Error) => setError(e.message))
                    }
                  >
                    Mark no response
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {s.dueSoon.length ? (
        <section className="panel">
          <h2>Due in the next 7 days</h2>
          <ul>
            {s.dueSoon.map((d) => (
              <li key={d.id}>
                <a href={`#/app/${d.id}`}>
                  {d.nextActionDue} · {d.company}
                </a>
                : {d.nextAction ?? "follow up"}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <div className="columns">
        <RateTable title="By score band" rows={s.byScoreBand} />
        <RateTable title="By tier" rows={s.byTier} />
        <RateTable title="By source" rows={s.bySource} />
        <RateTable title="By ATS" rows={s.byAts} />
        <RateTable title="By role family" rows={s.byRoleFamily} />
      </div>
    </section>
  );
}
