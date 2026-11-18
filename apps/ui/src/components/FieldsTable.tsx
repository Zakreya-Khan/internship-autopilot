import { useState } from "react";
import type { Field } from "../api.ts";

const SOURCE: Record<Field["source"], string> = {
  profile: "Profile",
  bank: "Bank",
  drafted: "Drafted",
  you: "You",
  mapped: "Mapped",
};

const FLAG_ORDER = { red: 0, amber: 1, grey: 2 } as const;

function FieldEditor({ field, onSave }: { field: Field; onSave: (v: string) => Promise<void> }) {
  const [value, setValue] = useState(field.planned_value ?? "");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await onSave(value);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="inline-edit"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {field.options?.length ? (
        <select aria-label={field.label} value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">Choose…</option>
          {field.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : field.field_type === "textarea" ? (
        <textarea
          aria-label={field.label}
          value={value}
          rows={4}
          onChange={(e) => setValue(e.target.value)}
        />
      ) : (
        <input aria-label={field.label} value={value} onChange={(e) => setValue(e.target.value)} />
      )}
      <button type="submit" disabled={busy || !value}>
        Save
      </button>
    </form>
  );
}

/** A learned answer to a similar question: use it, or say it doesn't fit. */
export function SuggestionNote({
  field,
  onSettle,
}: {
  field: Pick<Field, "label" | "options" | "suggestion">;
  onSettle?: ((accept: boolean, value?: string) => Promise<void>) | undefined;
}) {
  const s = field.suggestion;
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  if (!s) return null;
  const run = async (accept: boolean, value?: string) => {
    if (!onSettle) return;
    setBusy(true);
    try {
      await onSettle(accept, value);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="suggestion small" role="group" aria-label={`Suggestion for ${field.label}`}>
      <div>
        Suggested: <strong>{s.value}</strong>
      </div>
      <div className="muted">From a similar question: “{s.from}”</div>
      {!s.mapped ? (
        <div className="warn">Your answer isn't one of this form's options: pick one.</div>
      ) : null}
      {onSettle ? (
        <div className="actions">
          {!s.mapped && field.options?.length ? (
            <select
              aria-label={`Option for ${field.label}`}
              value={pick}
              onChange={(e) => setPick(e.target.value)}
            >
              <option value="">Choose…</option>
              {field.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : null}
          <button
            type="button"
            disabled={busy || (!s.mapped && !pick)}
            onClick={() => void run(true, s.mapped ? undefined : pick)}
          >
            Use it
          </button>
          <button type="button" className="quiet" disabled={busy} onClick={() => void run(false)}>
            Not this question
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function FieldsTable({
  fields,
  editable,
  onSave,
  onSuggestion,
}: {
  fields: Field[];
  editable: boolean;
  onSave: (key: string, value: string) => Promise<void>;
  onSuggestion?: (key: string, accept: boolean, value?: string) => Promise<void>;
}) {
  // Flagged fields first, so you read what needs you before what doesn't.
  const sorted = [...fields].sort(
    (a, b) => (a.flag ? FLAG_ORDER[a.flag] : 3) - (b.flag ? FLAG_ORDER[b.flag] : 3),
  );
  return (
    <table className="fields">
      <thead>
        <tr>
          <th scope="col">Field</th>
          <th scope="col">Value</th>
          <th scope="col">Source</th>
          <th scope="col">Flag</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((f) => (
          <tr key={f.field_key} data-flag={f.flag ?? "none"}>
            <td>
              {f.label}
              {f.required ? <span aria-label="required"> *</span> : null}
            </td>
            <td>
              {f.attach ? (
                <em>Attaches your {f.attach.replace("_", " ")}</em>
              ) : editable && (f.flag === "red" || f.flag === "amber" || f.source !== "profile") ? (
                <FieldEditor field={f} onSave={(v) => onSave(f.field_key, v)} />
              ) : (
                (f.planned_value ?? <span className="muted">empty</span>)
              )}
              {f.suggestion ? (
                <SuggestionNote
                  field={f}
                  onSettle={
                    editable && onSuggestion
                      ? (accept, v) => onSuggestion(f.field_key, accept, v)
                      : undefined
                  }
                />
              ) : null}
              {f.value_seen != null && f.value_seen !== f.planned_value ? (
                <div className="warn">Page showed: {f.value_seen || "(empty)"}</div>
              ) : null}
            </td>
            <td>
              {SOURCE[f.source]} <span className="muted">({f.confidence})</span>
            </td>
            <td>
              {f.flag ? (
                <span className={`flag flag-${f.flag}`}>
                  {f.flag === "red" ? "Needs you" : f.flag === "amber" ? "Check this" : "Info"}
                </span>
              ) : null}
              {f.note ? <div className="muted small">{f.note}</div> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
