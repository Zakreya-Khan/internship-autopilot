import { useCallback, useEffect, useState } from "react";
import type { LearnedAnswerRow } from "../api.ts";
import { api, questionsChanged } from "../api.ts";

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "never");

function AnswerRow({ a, onChanged }: { a: LearnedAnswerRow; onChanged: (msg: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(a.answer);
  const [pending, setPending] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<string>) => {
    setError(null);
    try {
      onChanged(await fn());
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <tr>
      <td>
        {a.question}
        {a.aliases.length ? (
          <ul className="wordings muted small">
            {a.aliases.map((al) => (
              <li key={al.key}>{al.text}</li>
            ))}
          </ul>
        ) : null}
      </td>
      <td>
        {editing ? (
          <form
            className="inline-edit"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const r = await api.editAnswer(a.id, { answer: value });
                setEditing(false);
                setPending(r.pending.length);
                return r.pending.length
                  ? `Saved. ${r.pending.length} pending application(s) still use the old answer.`
                  : "Saved.";
              });
            }}
          >
            {a.options?.length ? (
              <select
                aria-label={`Answer to ${a.question}`}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              >
                {a.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <textarea
                aria-label={`Answer to ${a.question}`}
                rows={3}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            )}
            <button type="submit" disabled={!value.trim()}>
              Save
            </button>
            <button type="button" className="quiet" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <span style={{ whiteSpace: "pre-wrap" }}>{a.answer}</span>
        )}
        {pending ? (
          <div className="actions">
            <button
              type="button"
              onClick={() =>
                void run(async () => {
                  const r = await api.applyAnswer(a.id);
                  setPending(0);
                  return `Updated ${r.updated} pending application(s)${r.skipped ? `; ${r.skipped} need you to pick from their options` : ""}.`;
                })
              }
            >
              Update {pending} pending application{pending === 1 ? "" : "s"}
            </button>
          </div>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
      </td>
      <td>
        {a.scope === "company" ? `${a.company} only` : "Always"}
        {a.scope === "always" ? (
          <div>
            <button
              type="button"
              className="quiet small"
              onClick={() =>
                void run(async () => {
                  await api.editAnswer(a.id, { scope: "company" });
                  return "Now reused only at the company you first answered it for.";
                })
              }
            >
              Limit to one company
            </button>
          </div>
        ) : null}
      </td>
      <td>
        {a.uses} application{a.uses === 1 ? "" : "s"}
        <div className="muted small">last used {day(a.lastUsedAt)}</div>
      </td>
      <td>
        <div className="actions">
          {!editing ? (
            <button type="button" className="quiet" onClick={() => setEditing(true)}>
              Edit
            </button>
          ) : null}
          <button
            type="button"
            className="quiet"
            onClick={() => {
              if (
                !window.confirm(
                  `Forget your answer to “${a.question}”? Filled fields keep their values.`,
                )
              )
                return;
              void run(async () => {
                await api.deleteAnswer(a.id);
                return "Forgotten.";
              });
            }}
          >
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}

export function Answers() {
  const [rows, setRows] = useState<LearnedAnswerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(
    () =>
      api
        .answers()
        .then(setRows)
        .catch((e: Error) => setError(e.message)),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  if (!rows) return error ? <p role="alert">{error}</p> : <p>Loading…</p>;
  return (
    <section>
      <h1>Answer bank</h1>
      <p className="muted">
        Answers you gave, reused on later forms for the same question or a wording you confirmed.
        They stay on this computer (data/). Work authorization, EEO, GPA and contact details are
        never kept here; they live in profile.yaml.
      </p>
      {message ? (
        <p role="status" className="ok">
          {message}
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {rows.length === 0 ? (
        <p>No answers yet. Answer questions on the Questions page and they'll show up here.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Question (and other wordings)</th>
              <th scope="col">Your answer</th>
              <th scope="col">Reused</th>
              <th scope="col">Used by</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <AnswerRow
                key={a.id}
                a={a}
                onChanged={(m) => {
                  setMessage(m);
                  questionsChanged();
                  void load();
                }}
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
