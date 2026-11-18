import { useCallback, useEffect, useRef, useState } from "react";
import type { JobKind, JobView } from "../api.ts";
import { api, changed } from "../api.ts";

/** How often a running job is re-read. */
export const POLL_MS = 1000;
/** A finished job's result stays on its page this long. */
const RECENT_MS = 15 * 60 * 1000;

/**
 * One kind of background job: start it, follow it while it runs, cancel it. On mount it picks
 * up the latest job of this kind, so leaving the page and coming back keeps the progress.
 */
export function useJob(kind: JobKind, onFinish?: (job: JobView) => void) {
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const finish = useRef(onFinish);
  finish.current = onFinish;

  useEffect(() => {
    let live = true;
    api
      .jobs()
      .then((all) => {
        // A running job, or one that finished in the last few minutes; older results are history.
        const latest = all.find(
          (j) =>
            j.kind === kind &&
            (j.status === "running" || Date.now() - Date.parse(j.finishedAt ?? "") < RECENT_MS),
        );
        if (live && latest) setJob(latest);
      })
      .catch(() => {
        /* the job list is optional here */
      });
    return () => {
      live = false;
    };
  }, [kind]);

  // A "still running" refusal is stale once any job finishes.
  useEffect(() => {
    const clear = () => setError(null);
    window.addEventListener("ia:changed", clear);
    return () => window.removeEventListener("ia:changed", clear);
  }, []);

  const id = job?.id;
  const running = job?.status === "running";
  useEffect(() => {
    if (id === undefined || !running) return;
    const t = setInterval(() => {
      api
        .job(id)
        .then((j) => {
          setJob(j);
          if (j.status !== "running") {
            changed();
            finish.current?.(j);
          }
        })
        .catch((e: Error) => setError(e.message));
    }, POLL_MS);
    return () => clearInterval(t);
  }, [id, running]);

  const start = useCallback(
    async (params: Record<string, unknown> = {}) => {
      setError(null);
      try {
        const j = await api.startJob(kind, params);
        setJob(j);
        changed();
        return j;
      } catch (e) {
        setError((e as Error).message);
        return null;
      }
    },
    [kind],
  );
  const cancel = useCallback(async () => {
    if (id === undefined) return;
    try {
      setJob(await api.cancelJob(id));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  return { job, error, start, cancel, running };
}

/** A job's progress, result or error, in plain words. */
export function JobStatus({
  job,
  error,
  onCancel,
  children,
}: {
  job: JobView | null;
  error?: string | null;
  onCancel?: () => void;
  /** Extra result details (lists, drafts) shown once the job is done. */
  children?: React.ReactNode;
}) {
  if (!job && !error) return null;
  const p = job?.progress;
  const pct = p && p.total ? Math.round((p.done / p.total) * 100) : null;
  return (
    <div className="job" aria-live="polite">
      {error ? <p role="alert">{error}</p> : null}
      {job ? (
        <>
          {job.status === "running" ? (
            <div className="job-running">
              <p className="row">
                <span>
                  <strong>{job.label}</strong>
                  {" · "}
                  {p?.note ?? "Starting…"}
                </span>
                {onCancel ? (
                  <button className="quiet" onClick={onCancel}>
                    Cancel
                  </button>
                ) : null}
              </p>
              <progress
                max={100}
                {...(pct !== null ? { value: pct } : {})}
                aria-label={`${job.label} progress`}
              />
              {p && p.total > 1 ? (
                <span className="muted small">
                  {p.done} of {p.total}
                </span>
              ) : null}
            </div>
          ) : (
            <p role="status" className={job.status === "done" ? "ok" : ""}>
              {job.status === "failed" ? null : job.summary}
              {job.status === "failed" ? <span role="alert">{job.error}</span> : null}{" "}
              <span className="muted small">{when(job.finishedAt)}</span>
            </p>
          )}
          {job.status !== "running" && children}
          {job.log.length ? (
            <details>
              <summary className="muted small">Notes from the run ({job.log.length})</summary>
              <ul className="small log">
                {job.log.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function when(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
  return new Date(iso).toLocaleDateString();
}
