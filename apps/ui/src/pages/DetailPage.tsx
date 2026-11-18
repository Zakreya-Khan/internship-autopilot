import { useCallback, useEffect, useState } from "react";
import type { Detail } from "../api.ts";
import { api, openPdf } from "../api.ts";
import { FieldsTable } from "../components/FieldsTable.tsx";
import { ResumeDiffView } from "../components/ResumeDiffView.tsx";

type Tab = "resume" | "answers" | "cover";

function DraftEditor({
  draft,
  onSave,
}: {
  draft: Detail["drafts"][number];
  onSave: (t: string) => Promise<void>;
}) {
  const [text, setText] = useState(draft.text);
  const [saving, setSaving] = useState(false);
  return (
    <div className={`draft ${draft.checker_status === "flagged" ? "draft-flagged" : ""}`}>
      {draft.question_text ? <h3>{draft.question_text}</h3> : null}
      {draft.checker_notes.length ? (
        <ul className="warn">
          {draft.checker_notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      ) : null}
      <textarea
        aria-label={draft.question_text ?? "Cover letter"}
        value={text}
        rows={draft.kind === "cover_letter" ? 14 : 5}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="row">
        <span className="muted small">
          Cites: {draft.cited_fact_ids.join(", ") || "nothing"}
          {draft.edited_by_user ? " · edited by you" : ""}
        </span>
        <button
          disabled={saving || text === draft.text}
          onClick={() => {
            setSaving(true);
            void onSave(text).finally(() => setSaving(false));
          }}
        >
          Save
        </button>
      </div>
    </div>
  );
}

export function DetailPage({ id }: { id: number }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("resume");

  const load = useCallback(
    () =>
      api
        .detail(id)
        .then(setD)
        .catch((e: Error) => setError(e.message)),
    [id],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const guard = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!d) return error ? <p role="alert">{error}</p> : <p>Loading…</p>;
  const { application: a, posting: p } = d;
  const editable = ["needs_input", "ready", "approved"].includes(a.status);
  const answers = d.drafts.filter((x) => x.kind === "answer");
  const cover = d.drafts.find((x) => x.kind === "cover_letter");

  return (
    <article>
      <p>
        <a href="#/">← Queue</a>
      </p>
      <header className="row">
        <div>
          <h1>
            {p.title} <span className="muted">· {p.company}</span>
          </h1>
          <p className="muted">
            {p.locations.join("; ")} · {p.ats} · Tier {a.tier}
            {d.score ? ` · fit ${d.score.score}` : ""} ·{" "}
            {p.deadline ? `deadline ${p.deadline}` : "rolling"}
          </p>
        </div>
        <div className="actions">
          {a.status === "ready" ? (
            <button onClick={() => void guard(() => api.setStatus(a.id, "approved"))}>
              Approve
            </button>
          ) : null}
          {a.status === "filled" ? (
            <button onClick={() => void guard(() => api.setStatus(a.id, "submitted", true))}>
              I submitted this
            </button>
          ) : null}
          <button
            className="quiet"
            onClick={() => void guard(() => api.setStatus(a.id, "skipped"))}
          >
            Skip
          </button>
        </div>
      </header>
      {error ? <p role="alert">{error}</p> : null}
      <p>
        Status: <strong>{a.status.replace("_", " ")}</strong>
        {d.flags.red ? ` · ${d.flags.red} field(s) need you before this can be approved` : ""}
      </p>

      <div className="columns">
        <section className="panel" aria-label="Posting">
          <h2>Posting</h2>
          {d.resume?.fitNote ? (
            <div className="note">
              <p>
                <strong>Why it fits:</strong> {d.resume.fitNote.why}
              </p>
              {d.resume.fitNote.gaps ? (
                <p>
                  <strong>What you lack:</strong> {d.resume.fitNote.gaps}
                </p>
              ) : null}
            </div>
          ) : null}
          {d.score?.match.missing.length ? (
            <p className="muted">Missing: {d.score.match.missing.join(", ")}</p>
          ) : null}
          <p>
            <a href={p.applyUrl} target="_blank" rel="noreferrer">
              Open the posting
            </a>
          </p>
          <pre className="description">{p.descriptionText ?? "No description fetched."}</pre>
        </section>

        <section className="panel" aria-label="Materials">
          <h2>Materials</h2>
          <div role="tablist" className="tabs">
            {(["resume", "answers", "cover"] as Tab[]).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                {t === "resume"
                  ? "Resume diff"
                  : t === "answers"
                    ? `Answers (${answers.length})`
                    : "Cover letter"}
              </button>
            ))}
          </div>
          {tab === "resume" && d.resume ? (
            <>
              <p>
                <button
                  className="quiet"
                  onClick={() =>
                    void openPdf(a.id, "resume").catch((e: Error) => setError(e.message))
                  }
                >
                  Open resume PDF
                </button>{" "}
                {d.resume.parseCheck.ok ? (
                  <span className="ok">Parse check passed</span>
                ) : (
                  <span className="warn">
                    Parse check failed: {d.resume.parseCheck.missing.join(", ")}
                  </span>
                )}
              </p>
              <ResumeDiffView diff={d.resume.diff} />
              {d.resume.issues.length ? (
                <details>
                  <summary>{d.resume.issues.length} truth-check note(s)</summary>
                  <ul>
                    {d.resume.issues.map((x, i) => (
                      <li key={i}>
                        <code>{x.where}</code> {x.problem}{" "}
                        {x.severity === "block" ? "(reverted to your original wording)" : ""}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </>
          ) : null}
          {tab === "answers" ? (
            answers.length ? (
              answers.map((x) => (
                <DraftEditor
                  key={x.id}
                  draft={x}
                  onSave={(t) => guard(() => api.editDraft(x.id, t))}
                />
              ))
            ) : (
              <p className="muted">No open questions on this form.</p>
            )
          ) : null}
          {tab === "cover" ? (
            cover ? (
              <>
                <DraftEditor
                  draft={cover}
                  onSave={(t) => guard(() => api.editDraft(cover.id, t))}
                />
                <button
                  className="quiet"
                  onClick={() =>
                    void openPdf(a.id, "cover_letter").catch((e: Error) => setError(e.message))
                  }
                >
                  Open cover letter PDF
                </button>
              </>
            ) : (
              <p className="muted">No cover letter for this one.</p>
            )
          ) : null}
        </section>
      </div>

      <section className="panel" aria-label="Fields">
        <h2>Every field the form will get</h2>
        <FieldsTable
          fields={d.fields}
          editable={editable}
          onSave={(key, v) => guard(() => api.setField(a.id, key, v))}
        />
      </section>
    </article>
  );
}
