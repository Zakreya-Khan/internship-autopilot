import { useEffect, useState } from "react";
import type { QualifyItem } from "../api.ts";
import { api } from "../api.ts";

type Verdict = "meets" | "close";

const MARK = { true: "Met", false: "Short", null: "Can't tell" } as const;

export function Qualify() {
  const [verdict, setVerdict] = useState<Verdict>("meets");
  const [items, setItems] = useState<QualifyItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setItems(null);
    api
      .qualify(verdict)
      .then(setItems)
      .catch((e: Error) => setError(e.message));
  }, [verdict]);

  if (error) return <p role="alert">{error}</p>;
  return (
    <section>
      <header className="row">
        <h1>Do you qualify?</h1>
        <label>
          Show{" "}
          <select value={verdict} onChange={(e) => setVerdict(e.target.value as Verdict)}>
            <option value="meets">You meet every minimum</option>
            <option value="close">One requirement short</option>
          </select>
        </label>
      </header>
      <p className="muted">
        Only requirements a posting states are checked: degree, graduation date, GPA, years of
        experience and (with a Claude key) required skills. Work authorization and sponsorship are
        never judged for you. Postings that state fewer than two minimums aren't listed.
      </p>
      {!items ? (
        <p>Loading…</p>
      ) : items.length === 0 ? (
        <p>
          Nothing here yet. Run `npm run ia -- refresh` to fetch descriptions, and set
          ANTHROPIC_API_KEY so each posting's required skills are read.
        </p>
      ) : (
        <table className="queue">
          <thead>
            <tr>
              <th scope="col">Company</th>
              <th scope="col">Role</th>
              <th scope="col">Tier</th>
              <th scope="col">Fit</th>
              <th scope="col">Requirements</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.postingId}>
                <td>{i.company}</td>
                <td>
                  {i.applicationId ? (
                    <a href={`#/app/${i.applicationId}`}>{i.title}</a>
                  ) : (
                    <a href={i.applyUrl} target="_blank" rel="noopener noreferrer">
                      {i.title}
                    </a>
                  )}
                </td>
                <td>{i.tier ?? "–"}</td>
                <td>{i.score ?? "–"}</td>
                <td>
                  <ul className="plain">
                    {i.qualification.checks.map((c, n) => (
                      <li key={n}>
                        <span className={c.met === false ? "flag flag-red" : "muted"}>
                          {MARK[String(c.met) as keyof typeof MARK]}
                        </span>{" "}
                        {c.need}
                        {c.have ? <span className="muted"> (you: {c.have})</span> : null}
                      </li>
                    ))}
                    {i.qualification.notes.map((n) => (
                      <li key={n} className="muted small">
                        {n}
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
