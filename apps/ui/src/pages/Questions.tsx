import { useCallback, useEffect, useState } from "react";
import type { AnswerResult, InboxGroup, Scope } from "../api.ts";
import { api, questionsChanged } from "../api.ts";
import { SuggestionNote } from "../components/FieldsTable.tsx";

const SCOPE_LABEL: Record<Scope, string> = {
  always: "Always reuse",
  company: "This company only",
  once: "Just this once",
};

function isYesNo(options: string[] | null): boolean {
  return Boolean(options?.length === 2 && options.every((o) => /^(yes|no)$/i.test(o.trim())));
}

function AnswerInput({
  group,
  value,
  onChange,
}: {
  group: InboxGroup;
  value: string;
  onChange: (v: string) => void;
}) {
  const label = `Your answer: ${group.question}`;
  if (isYesNo(group.options))
    return (
      <fieldset className="scope" aria-label={label}>
        {group.options!.map((o) => (
          <label key={o}>
            <input
              type="radio"
              name={`yn-${group.id}`}
              value={o}
              checked={value === o}
              onChange={() => onChange(o)}
            />{" "}
            {o}
          </label>
        ))}
      </fieldset>
    );
  if (group.options?.length)
    return (
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {group.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  if (group.type === "checkbox")
    return (
      <label>
        <input
          type="checkbox"
          aria-label={label}
          checked={value === "Yes"}
          onChange={(e) => onChange(e.target.checked ? "Yes" : "No")}
        />{" "}
        Yes
      </label>
    );
  if (group.type === "textarea")
    return (
      <textarea
        aria-label={label}
        rows={4}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  return (
    <input
      aria-label={label}
      type={group.type === "number" ? "number" : group.type === "date" ? "date" : "text"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function scopesFor(g: InboxGroup): Scope[] {
  if (g.sensitive) return ["once"];
  if (g.companySpecific) return ["company", "once"];
  return ["always", "company", "once"];
}

function resultText(r: AnswerResult): string {
  const parts = [`Filled ${r.filled} field${r.filled === 1 ? "" : "s"}`];
  if (r.backfill.filled) parts.push(`${r.backfill.filled} more on other applications`);
  if (r.backfill.suggested) parts.push(`${r.backfill.suggested} suggestion(s) to confirm`);
  if (r.unmapped.length)
    parts.push(`${r.unmapped.length} form(s) need you to pick from their own options`);
  if (r.touched.length) parts.push(`${r.touched.length} application(s) changed status`);
  return `${parts.join(", ")}.`;
}

function GroupCard({ group, onDone }: { group: InboxGroup; onDone: (msg: string) => void }) {
  const [value, setValue] = useState("");
  const scopes = scopesFor(group);
  const [scope, setScope] = useState<Scope>(
    scopes.includes(group.defaultScope) ? group.defaultScope : scopes[0]!,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const companies = group.companies.join(", ");
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.answerQuestion(
        group.items.map((i) => ({ applicationId: i.applicationId, fieldKey: i.fieldKey })),
        value,
        scope,
      );
      onDone(resultText(r));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const settle =
    (applicationId: number, fieldKey: string) => async (accept: boolean, v?: string) => {
      try {
        await api.settleSuggestion(applicationId, fieldKey, accept, v);
        onDone(
          accept
            ? "Suggestion used."
            : "Got it: that answer won't be offered for this question again.",
        );
      } catch (e) {
        setError((e as Error).message);
      }
    };
  return (
    <section className="panel question" aria-label={group.question}>
      <h2>
        {group.question}
        {group.required ? <span aria-label="required"> *</span> : null}
      </h2>
      {group.wordings.length ? (
        <div className="muted small">
          Also asked as:
          <ul className="wordings">
            {group.wordings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="muted small">
        Asked by {group.items.length} application{group.items.length === 1 ? "" : "s"}: {companies}
      </div>
      {group.sensitive ? (
        <p className="small warn">
          This is about work authorization, EEO, GPA or contact details. Your answer fills these
          applications only; it's never saved to your answer bank. Your standing answers live in
          profile.yaml.
        </p>
      ) : null}
      {group.items
        .filter((i) => i.suggestion)
        .map((i) => (
          <div key={`${i.applicationId}:${i.fieldKey}`}>
            <span className="small">{i.company}:</span>
            <SuggestionNote field={i} onSettle={settle(i.applicationId, i.fieldKey)} />
          </div>
        ))}
      <form
        className="question"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <AnswerInput group={group} value={value} onChange={setValue} />
        <fieldset className="scope">
          <legend className="sr-only">Reuse this answer</legend>
          {scopes.map((s) => (
            <label key={s}>
              <input
                type="radio"
                name={`scope-${group.id}`}
                value={s}
                checked={scope === s}
                onChange={() => setScope(s)}
              />{" "}
              {SCOPE_LABEL[s]}
            </label>
          ))}
        </fieldset>
        {group.companySpecific ? (
          <p className="muted small">
            It asks about you and {group.companies[0]}, so it's never reused at another company.
          </p>
        ) : null}
        <div className="actions">
          <button type="submit" disabled={busy || !value.trim()}>
            {group.items.length > 1 ? `Answer for all ${group.items.length}` : "Answer"}
          </button>
        </div>
        {error ? <p role="alert">{error}</p> : null}
      </form>
    </section>
  );
}

export function Questions() {
  const [groups, setGroups] = useState<InboxGroup[] | null>(null);
  const [optional, setOptional] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(
    () =>
      api
        .questions(optional)
        .then((r) => setGroups(r.groups))
        .catch((e: Error) => setError(e.message)),
    [optional],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (!groups) return error ? <p role="alert">{error}</p> : <p>Loading…</p>;
  return (
    <section>
      <h1>Questions</h1>
      <p className="muted">
        Questions the tool couldn't answer, across every application you haven't submitted. Answer
        once: every application asking it is filled, and the same or a similar question is filled or
        suggested next time. Your typed answers are used word for word.
      </p>
      <label className="small">
        <input type="checkbox" checked={optional} onChange={(e) => setOptional(e.target.checked)} />{" "}
        Show optional questions too
      </label>
      {message ? (
        <p role="status" className="ok">
          {message}
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {groups.length === 0 ? (
        <p>Nothing waiting for you. 🎉</p>
      ) : (
        groups.map((g) => (
          <GroupCard
            key={g.id}
            group={g}
            onDone={(m) => {
              setMessage(m);
              questionsChanged();
              void load();
            }}
          />
        ))
      )}
    </section>
  );
}
