import { useCallback, useEffect, useState } from "react";
import type { ProviderSettings, QueueItem, Summary } from "../api.ts";
import { api } from "../api.ts";
import { JobStatus, useJob, when } from "../components/Jobs.tsx";
import { OpenFill } from "../components/OpenFill.tsx";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "needs" for one, "need" for several. */
const verb = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The home page: what to do next, in order, with the button that does it. */
export function Home() {
  const [s, setS] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState<QueueItem[]>([]);
  const [provider, setProvider] = useState<ProviderSettings | null>(null);
  const [prepCount, setPrepCount] = useState(5);

  const load = useCallback(() => {
    api
      .summary()
      .then((x) => {
        setS(x);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
    api
      .queue("approved")
      .then(setApproved)
      .catch(() => setApproved([]));
  }, []);
  useEffect(() => {
    load();
    api
      .providerSettings()
      .then(setProvider)
      .catch(() => setProvider(null));
    window.addEventListener("ia:changed", load);
    return () => window.removeEventListener("ia:changed", load);
  }, [load]);

  const refresh = useJob("refresh", load);
  const prep = useJob("prep", load);

  if (error) return <p role="alert">Couldn't load the home page: {error}</p>;
  if (!s) return <p>Loading…</p>;

  const steps: { key: string; done: boolean; body: React.ReactNode }[] = [
    {
      key: "questions",
      done: s.questions === 0,
      body: (
        <>
          <h2>Answer {plural(s.questions, "question")} only you can answer</h2>
          <p className="muted">One answer fills every application asking it.</p>
          <a className="button" href="#/questions">
            Open Questions
          </a>
        </>
      ),
    },
    {
      key: "ready",
      done: s.ready === 0,
      body: (
        <>
          <h2>
            Approve {plural(s.ready, "application")} that {verb(s.ready, "is", "are")} ready
          </h2>
          <p className="muted">Read the tailored resume and answers, then approve or skip.</p>
          <a className="button" href="#/queue/ready">
            Review ready
          </a>
        </>
      ),
    },
    {
      key: "approved",
      done: s.approved === 0,
      body: (
        <>
          <h2>Fill and submit {plural(s.approved, "approved application")}</h2>
          <p className="muted">
            Open &amp; fill opens the application in a new tab and the extension fills it. You press
            Submit.
          </p>
          <ul className="plain stack">
            {approved.slice(0, 5).map((a) => (
              <li key={a.id} className="row">
                <a href={`#/app/${a.id}`}>
                  {a.posting.company}: {a.posting.title}
                </a>
                <OpenFill id={a.id} company={a.posting.company} />
              </li>
            ))}
          </ul>
          {approved.length > 5 ? (
            <a href="#/queue/approved">All {approved.length} approved</a>
          ) : null}
        </>
      ),
    },
    {
      key: "filled",
      done: s.filled === 0,
      body: (
        <>
          <h2>
            {plural(s.filled, "filled page")} {verb(s.filled, "is", "are")} waiting for your Submit
          </h2>
          <p className="muted">
            Press Submit on the site. The extension records it when it sees the confirmation page;
            if it didn't, mark it on the application.
          </p>
          <a className="button" href="#/queue/filled">
            See filled
          </a>
        </>
      ),
    },
    {
      key: "needs",
      done: s.needsInput === 0,
      body: (
        <>
          <h2>
            {plural(s.needsInput, "application")} {verb(s.needsInput, "needs", "need")} your input
          </h2>
          <p className="muted">
            Usually a question in the inbox, a draft the truth check stopped, or a file to attach.
          </p>
          <a className="button" href="#/queue/needs_input">
            See what's missing
          </a>
        </>
      ),
    },
    {
      key: "prep",
      done: s.postings.unstartedAB === 0,
      body: (
        <>
          <h2>Prepare more: {plural(s.postings.unstartedAB, "Tier A or B posting")} not started</h2>
          <p className="muted">
            Each is checked still open, then tailored, truth-checked and planned. Best fit first.
          </p>
          <div className="actions">
            <label>
              How many{" "}
              <input
                type="number"
                min={1}
                max={25}
                className="narrow"
                value={prepCount}
                onChange={(e) => setPrepCount(Number(e.target.value) || 1)}
              />
            </label>
            <button disabled={prep.running} onClick={() => void prep.start({ limit: prepCount })}>
              {prep.running ? "Preparing…" : `Prepare the next ${prepCount}`}
            </button>
            <a href="#/discover">or pick in Discover</a>
          </div>
          <JobStatus job={prep.job} error={prep.error} onCancel={() => void prep.cancel()} />
        </>
      ),
    },
  ];
  const todo = steps.filter((x) => !x.done);

  return (
    <section>
      <h1>What to do next</h1>
      {provider && !provider.ready ? (
        <p className="note">
          Claude isn't set up ({provider.reason ?? "no provider"}), so scoring uses keywords and
          drafting is off. <a href="#/settings">Set it up in Settings</a>.
        </p>
      ) : null}
      {s.postings.open === 0 ? (
        <div className="panel empty">
          <h2>Start by finding postings</h2>
          <p>
            This polls the GitHub internship list and the job boards on your watchlist, then scores
            each posting against your profile. It takes a minute or two.
          </p>
          <button disabled={refresh.running} onClick={() => void refresh.start()}>
            Find postings
          </button>
          <JobStatus
            job={refresh.job}
            error={refresh.error}
            onCancel={() => void refresh.cancel()}
          />
        </div>
      ) : null}
      {todo.length === 0 && s.postings.open > 0 ? (
        <div className="panel">
          <h2>You're caught up</h2>
          <p className="muted">
            Nothing is waiting on you. Find new postings, or browse the ones you have in Discover.
          </p>
        </div>
      ) : null}
      <ol className="steps">
        {todo.map((x) => (
          <li key={x.key} className="panel">
            {x.body}
          </li>
        ))}
      </ol>

      <div className="columns">
        <div className="panel">
          <h2>Postings</h2>
          <p>
            {s.postings.passed} open postings pass your filters; {s.postings.unstarted} aren't
            started.
          </p>
          <p className="muted small">
            Last searched {s.lastRefresh ? when(s.lastRefresh) : "never"}.
          </p>
          <div className="actions">
            <button disabled={refresh.running} onClick={() => void refresh.start()}>
              {refresh.running ? "Finding postings…" : "Find new postings"}
            </button>
            <a className="button quiet-link" href="#/discover">
              Browse in Discover
            </a>
          </div>
          {s.postings.open > 0 ? (
            <JobStatus
              job={refresh.job}
              error={refresh.error}
              onCancel={() => void refresh.cancel()}
            />
          ) : null}
        </div>
        <div className="panel">
          <h2>Applications</h2>
          <p>
            {s.sent} sent · {s.approved} approved · {s.ready} ready · {s.needsInput} need input
          </p>
          {s.dueSoon ? (
            <p>
              <a href="#/tracker">{plural(s.dueSoon, "follow-up")} due within a week</a>
            </p>
          ) : null}
          {s.openBatches ? (
            <p className="muted small">
              {plural(s.openBatches, "batch", "batches")} at the Batch API.{" "}
              <a href="#/tools">Collect results</a>
            </p>
          ) : null}
          <a href="#/tracker">Open the tracker</a>
        </div>
      </div>
    </section>
  );
}
