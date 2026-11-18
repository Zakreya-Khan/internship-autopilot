import { useCallback, useEffect, useState } from "react";
import type { JobView, PostingRow, ProviderSettings } from "../api.ts";
import { api, downloadExport } from "../api.ts";
import { JobStatus, useJob, when } from "../components/Jobs.tsx";

/** Everything the command line does, as buttons. Each runs in the background on your computer. */
export function Tools() {
  const [provider, setProvider] = useState<ProviderSettings | null>(null);
  useEffect(() => {
    api
      .providerSettings()
      .then(setProvider)
      .catch(() => setProvider(null));
  }, []);
  return (
    <section>
      <h1>Tools</h1>
      <p className="muted">
        Each of these runs in the background on your computer; you can leave the page and come back.
        Only one job that changes postings or applications runs at a time. None of them submit
        anything.
      </p>
      <div className="columns">
        <FindPostings />
        <CheckOpen />
        <Prepare />
        <Batches cli={provider?.selected === "cli"} />
        <Stories />
        <Outreach />
        <EmailSync />
        <Export />
      </div>
      <History />
    </section>
  );
}

function FindPostings() {
  const job = useJob("refresh");
  const [simplify, setSimplify] = useState(true);
  const [watchlist, setWatchlist] = useState(true);
  const [company, setCompany] = useState("");
  const [useModel, setUseModel] = useState(true);
  return (
    <div className="panel">
      <h2>Find postings</h2>
      <p className="muted small">
        Polls the sources, scores every open posting against your profile, and fetches details for
        the best ones.
      </p>
      <fieldset className="opts">
        <label>
          <input
            type="checkbox"
            checked={simplify}
            onChange={(e) => setSimplify(e.target.checked)}
          />{" "}
          GitHub internship list
        </label>
        <label>
          <input
            type="checkbox"
            checked={watchlist}
            onChange={(e) => setWatchlist(e.target.checked)}
          />{" "}
          Your watchlist boards
        </label>
        <label>
          Only this company{" "}
          <input
            value={company}
            placeholder="optional"
            onChange={(e) => setCompany(e.target.value)}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={useModel}
            onChange={(e) => setUseModel(e.target.checked)}
          />{" "}
          Use Claude to read requirements (Haiku; off: keyword scoring, free)
        </label>
      </fieldset>
      <button
        disabled={job.running || (!simplify && !watchlist)}
        onClick={() => void job.start({ simplify, watchlist, useModel, company })}
      >
        {job.running ? "Finding…" : "Find postings"}
      </button>
      <JobStatus job={job.job} error={job.error} onCancel={() => void job.cancel()} />
    </div>
  );
}

function CheckOpen() {
  const job = useJob("check-open");
  const [limit, setLimit] = useState(25);
  const result = job.job?.result as {
    rows: { postingId: string; company: string; title: string; verdict: string; reason: string }[];
  } | null;
  const closed = result?.rows.filter((r) => r.verdict === "expired") ?? [];
  return (
    <div className="panel">
      <h2>Check which postings are still open</h2>
      <p className="muted small">
        Asks each job board about your best candidates. Closed ones are recorded and never come
        back. Prep and Open &amp; fill also check on their own.
      </p>
      <div className="actions">
        <label>
          Top{" "}
          <input
            type="number"
            min={1}
            max={200}
            className="narrow"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value) || 1)}
          />
        </label>
        <button disabled={job.running} onClick={() => void job.start({ limit })}>
          Check
        </button>
      </div>
      <JobStatus job={job.job} error={job.error} onCancel={() => void job.cancel()}>
        {closed.length ? (
          <ul className="small">
            {closed.map((r) => (
              <li key={r.postingId}>
                Closed: {r.company}: {r.title} <span className="muted">({r.reason})</span>
              </li>
            ))}
          </ul>
        ) : null}
      </JobStatus>
    </div>
  );
}

function Prepare() {
  const job = useJob("prep");
  const [limit, setLimit] = useState(5);
  const [tiers, setTiers] = useState<string[]>(["A", "B"]);
  const [sonnet, setSonnet] = useState(false);
  const flip = (t: string) =>
    setTiers((x) => (x.includes(t) ? x.filter((y) => y !== t) : [...x, t].sort()));
  return (
    <div className="panel">
      <h2>Prepare applications</h2>
      <p className="muted small">
        Tailors a resume, drafts answers, truth-checks every claim and plans each form, for your
        best unprepared postings. Unfinished ones go first. To choose exact postings, tick them in{" "}
        <a href="#/discover">Discover</a>.
      </p>
      <fieldset className="opts">
        <label>
          How many{" "}
          <input
            type="number"
            min={1}
            max={50}
            className="narrow"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value) || 1)}
          />
        </label>
        <span>
          Tiers{" "}
          {["A", "B", "C"].map((t) => (
            <label key={t}>
              <input type="checkbox" checked={tiers.includes(t)} onChange={() => flip(t)} />{" "}
              {t}{" "}
            </label>
          ))}
        </span>
        <label>
          <input type="checkbox" checked={sonnet} onChange={(e) => setSonnet(e.target.checked)} />{" "}
          Sonnet for Tier B (cheaper)
        </label>
      </fieldset>
      <button
        disabled={job.running || tiers.length === 0}
        onClick={() => void job.start({ limit, tiers, sonnet })}
      >
        {job.running ? "Preparing…" : "Prepare"}
      </button>
      <JobStatus job={job.job} error={job.error} onCancel={() => void job.cancel()}>
        <p>
          <a href="#/queue">Open the queue</a>
        </p>
      </JobStatus>
    </div>
  );
}

function Batches({ cli }: { cli: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  const loadOpen = useCallback(
    () =>
      void api
        .batches()
        .then((b) => setOpen(b.length))
        .catch(() => setOpen(null)),
    [],
  );
  useEffect(loadOpen, [loadOpen]);
  const submit = useJob("batch-submit", loadOpen);
  const collect = useJob("batch-collect", loadOpen);
  const cancel = useJob("batch-cancel", loadOpen);
  const [limit, setLimit] = useState(50);
  const busy = submit.running || collect.running || cancel.running;
  return (
    <div className="panel">
      <h2>Batch API (Tier B at half price)</h2>
      <p className="muted small">
        {cli
          ? "You're using the Claude CLI, which has no Batch API: Send prepares Tier B one at a time instead. Switch to an API key in Settings for half-price batches."
          : "Sends Tier B drafting as one batch. Results come back within 24 hours; then press Collect to finish them."}
      </p>
      <p className="small">
        {open === null ? "" : open ? `${open} batch(es) waiting at the API.` : "No open batches."}
      </p>
      <div className="actions">
        <label>
          Up to{" "}
          <input
            type="number"
            min={1}
            max={200}
            className="narrow"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value) || 1)}
          />
        </label>
        <button disabled={busy} onClick={() => void submit.start({ limit })}>
          Send
        </button>
        <button className="quiet" disabled={busy || cli} onClick={() => void collect.start()}>
          Collect
        </button>
        <button
          className="quiet"
          disabled={busy || cli || !open}
          onClick={() => void cancel.start()}
        >
          Cancel batches
        </button>
      </div>
      <JobStatus job={submit.job} error={submit.error} onCancel={() => void submit.cancel()} />
      <JobStatus job={collect.job} error={collect.error} />
      <JobStatus job={cancel.job} error={cancel.error} />
    </div>
  );
}

function Stories() {
  const [md, setMd] = useState<string | null>(null);
  const load = useCallback(
    () =>
      void api
        .stories()
        .then((r) => setMd(r.markdown))
        .catch(() => setMd(null)),
    [],
  );
  useEffect(load, [load]);
  const job = useJob("stories", load);
  const [count, setCount] = useState(8);
  return (
    <div className="panel">
      <h2>Interview stories</h2>
      <p className="muted small">
        STAR stories from your own facts, saved to data/stories.md. Every number must appear in a
        fact the story cites; anything else is marked.
      </p>
      <div className="actions">
        <label>
          How many{" "}
          <input
            type="number"
            min={1}
            max={20}
            className="narrow"
            value={count}
            onChange={(e) => setCount(Number(e.target.value) || 1)}
          />
        </label>
        <button disabled={job.running} onClick={() => void job.start({ count })}>
          Write stories
        </button>
      </div>
      <JobStatus job={job.job} error={job.error} />
      {md ? (
        <details>
          <summary>Your stories</summary>
          <pre className="description">{md}</pre>
        </details>
      ) : null}
    </div>
  );
}

function Outreach() {
  const job = useJob("outreach");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<PostingRow[]>([]);
  const [pick, setPick] = useState<PostingRow | null>(null);
  const [to, setTo] = useState<"recruiter" | "referral">("recruiter");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    const t = setTimeout(
      () =>
        void api
          .postings({ q, open: "all", filter: "all", limit: 6 })
          .then((r) => setHits(r.items))
          .catch(() => setHits([])),
      250,
    );
    return () => clearTimeout(t);
  }, [q]);
  const result = job.job?.result as { message: string; problems: string[] } | null;
  return (
    <div className="panel">
      <h2>Outreach message</h2>
      <p className="muted small">
        A short note to a recruiter or for a referral, for you to send yourself. Nothing is sent,
        and nothing goes near LinkedIn.
      </p>
      {pick ? (
        <p>
          {pick.company}: {pick.title}{" "}
          <button className="quiet" onClick={() => setPick(null)}>
            Change
          </button>
        </p>
      ) : (
        <>
          <label>
            Posting{" "}
            <input
              type="search"
              value={q}
              placeholder="Search company or role"
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
          <ul className="plain small">
            {hits.map((h) => (
              <li key={h.id}>
                <button className="quiet" onClick={() => setPick(h)}>
                  {h.company}: {h.title}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="actions">
        <label>
          <input type="radio" checked={to === "recruiter"} onChange={() => setTo("recruiter")} />{" "}
          Recruiter
        </label>
        <label>
          <input type="radio" checked={to === "referral"} onChange={() => setTo("referral")} />{" "}
          Referral
        </label>
        <button
          disabled={!pick || job.running}
          onClick={() => void job.start({ postingId: pick!.id, to })}
        >
          Draft
        </button>
      </div>
      <JobStatus job={job.job} error={job.error}>
        {result ? (
          <>
            <textarea readOnly rows={6} value={result.message} aria-label="Draft message" />
            {result.problems.length ? (
              <ul className="warn small">
                {result.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : null}
            <button
              className="quiet"
              onClick={() =>
                void navigator.clipboard.writeText(result.message).then(() => setCopied(true))
              }
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </>
        ) : null}
      </JobStatus>
    </div>
  );
}

function EmailSync() {
  const job = useJob("email-sync");
  const [path, setPath] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const result = job.job?.result as {
    updated: { company: string; from: string; to: string; subject: string }[];
  } | null;
  return (
    <div className="panel">
      <h2>Update statuses from email</h2>
      <p className="muted small">
        Reads an email export on this computer (an .mbox file, or a folder of .eml files) and moves
        applications along: rejections, assessments, interviews. Rule-based; nothing is sent
        anywhere.
      </p>
      <label className="settings-field">
        Path to the export
        <input
          value={path}
          placeholder="/Users/you/Downloads/Mail.mbox"
          onChange={(e) => setPath(e.target.value)}
        />
      </label>
      <div className="actions">
        <label>
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />{" "}
          Dry run (show what would change)
        </label>
        <button
          disabled={!path.trim() || job.running}
          onClick={() => void job.start({ path, dryRun })}
        >
          Read emails
        </button>
      </div>
      <JobStatus job={job.job} error={job.error}>
        {result?.updated.length ? (
          <ul className="small">
            {result.updated.map((u, i) => (
              <li key={i}>
                {u.company}: {u.from} → {u.to} <span className="muted">({u.subject})</span>
              </li>
            ))}
          </ul>
        ) : null}
      </JobStatus>
    </div>
  );
}

function Export() {
  const [error, setError] = useState<string | null>(null);
  const get = (f: "csv" | "tsv") => void downloadExport(f).catch((e: Error) => setError(e.message));
  return (
    <div className="panel">
      <h2>Export the tracker</h2>
      <p className="muted small">
        Every application with its status and dates, for Google Sheets (File → Import) or Excel.
        Model spend is on <a href="#/stats">Stats</a>.
      </p>
      <div className="actions">
        <button onClick={() => get("csv")}>Download CSV</button>
        <button className="quiet" onClick={() => get("tsv")}>
          Download TSV
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

function History() {
  const [jobs, setJobs] = useState<JobView[] | null>(null);
  const load = useCallback(
    () =>
      void api
        .jobs()
        .then(setJobs)
        .catch(() => setJobs(null)),
    [],
  );
  useEffect(() => {
    load();
    window.addEventListener("ia:changed", load);
    return () => window.removeEventListener("ia:changed", load);
  }, [load]);
  if (!jobs?.length) return null;
  return (
    <div className="panel">
      <h2>Recent jobs</h2>
      <p className="muted small">Kept until the server restarts.</p>
      <table>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <td>{j.label}</td>
              <td>{j.status}</td>
              <td className="small">{j.status === "failed" ? j.error : j.summary}</td>
              <td className="small muted">{when(j.finishedAt ?? j.startedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
