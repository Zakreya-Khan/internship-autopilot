import { useCallback, useEffect, useState } from "react";
import type { PostingQuery, PostingRow, PostingSearch } from "../api.ts";
import { api, changed } from "../api.ts";
import { JobStatus, useJob } from "../components/Jobs.tsx";
import { STATUS_LABEL } from "../labels.ts";

const PAGE = 50;
const DEFAULTS: PostingQuery = {
  q: "",
  tier: "",
  minScore: "",
  company: "",
  location: "",
  source: "",
  open: "open",
  filter: "passed",
  status: "any",
  sort: "score",
};
const SAVED = "ia-discover-filters";

function loadFilters(): PostingQuery {
  try {
    const raw = localStorage.getItem(SAVED);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as PostingQuery) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

const SOURCE_LABEL: Record<string, string> = {
  simplify: "GitHub list",
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
  workday: "Workday",
  smartrecruiters: "SmartRecruiters",
  icims: "iCIMS",
  manual: "Added by you",
};

export function Discover() {
  const [filters, setFilters] = useState<PostingQuery>(loadFilters);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<PostingSearch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    return api
      .postings({ ...filters, offset, limit: PAGE })
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [filters, offset]);
  useEffect(() => {
    const t = setTimeout(() => void load(), 200); // let typing settle
    return () => clearTimeout(t);
  }, [load]);
  useEffect(() => {
    try {
      localStorage.setItem(SAVED, JSON.stringify(filters));
    } catch {
      /* storage unavailable */
    }
  }, [filters]);

  const prep = useJob("prep", () => void load());
  const check = useJob("check-open", () => void load());
  const refresh = useJob("refresh", () => void load());

  const set = (k: keyof PostingQuery, v: string) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setOffset(0);
    setPicked(new Set());
  };
  const ids = [...picked];
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const rows = data?.items ?? [];
  const allOnPage = rows.length > 0 && rows.every((r) => picked.has(r.id));
  const skippedPicked = rows.some((r) => picked.has(r.id) && r.application?.status === "skipped");

  const skip = async (undo: boolean) => {
    try {
      const r = await api.skipPostings(ids, undo);
      setNote(
        undo
          ? `Restored ${r.restored ?? 0}. They'll be prepared on the next run.`
          : `Skipped ${r.skipped ?? 0}.${r.left ? ` ${r.left} already approved or sent were left alone.` : ""}`,
      );
      setPicked(new Set());
      changed();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section>
      <header className="row">
        <div>
          <h1>Discover postings</h1>
          <p className="muted small">
            {data
              ? `${data.counts.passed} open postings pass your filters, of ${data.counts.open} open (${data.counts.all} ever seen).`
              : "Every posting the sources found."}
          </p>
        </div>
        <button disabled={refresh.running} onClick={() => void refresh.start()}>
          {refresh.running ? "Finding postings…" : "Find new postings"}
        </button>
      </header>
      <JobStatus job={refresh.job} error={refresh.error} onCancel={() => void refresh.cancel()} />

      <form
        className="filters panel"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <label className="grow">
          Search
          <input
            type="search"
            placeholder="Company, role or place"
            value={filters.q}
            onChange={(e) => set("q", e.target.value)}
          />
        </label>
        <label>
          Company
          <input value={filters.company} onChange={(e) => set("company", e.target.value)} />
        </label>
        <label>
          Location
          <input
            value={filters.location}
            placeholder="e.g. Remote"
            onChange={(e) => set("location", e.target.value)}
          />
        </label>
        <label>
          Tier
          <select value={filters.tier} onChange={(e) => set("tier", e.target.value)}>
            <option value="">Any</option>
            <option value="A">A</option>
            <option value="B">B</option>
            <option value="C">C</option>
          </select>
        </label>
        <label>
          Min fit
          <input
            type="number"
            min={0}
            max={100}
            className="narrow"
            value={filters.minScore}
            onChange={(e) => set("minScore", e.target.value)}
          />
        </label>
        <label>
          Source
          <select value={filters.source} onChange={(e) => set("source", e.target.value)}>
            <option value="">Any</option>
            {(data?.sources ?? []).map((s) => (
              <option key={s.name} value={s.name}>
                {SOURCE_LABEL[s.name] ?? s.name} ({s.count})
              </option>
            ))}
          </select>
        </label>
        <label>
          Open
          <select value={filters.open} onChange={(e) => set("open", e.target.value)}>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="all">Both</option>
          </select>
        </label>
        <label>
          Your filters
          <select value={filters.filter} onChange={(e) => set("filter", e.target.value)}>
            <option value="passed">Pass</option>
            <option value="dropped">Filtered out</option>
            <option value="all">All</option>
          </select>
        </label>
        <label>
          Status
          <select value={filters.status} onChange={(e) => set("status", e.target.value)}>
            <option value="any">Any</option>
            <option value="none">Not started</option>
            <option value="active">In progress</option>
            <option value="submitted">Sent</option>
            <option value="skipped">Skipped</option>
          </select>
        </label>
        <label>
          Sort
          <select value={filters.sort} onChange={(e) => set("sort", e.target.value)}>
            <option value="score">Best fit</option>
            <option value="newest">Newest</option>
            <option value="deadline">Deadline</option>
            <option value="company">Company</option>
          </select>
        </label>
        <button
          type="button"
          className="quiet"
          onClick={() => {
            setFilters(DEFAULTS);
            setOffset(0);
          }}
        >
          Reset
        </button>
      </form>

      <div className="bulk row" aria-label="Selected postings">
        <span className="muted small">
          {picked.size ? `${picked.size} selected` : "Tick postings to act on several at once."}
        </span>
        <div className="actions">
          <button
            disabled={!picked.size || prep.running}
            onClick={() => void prep.start({ postingIds: ids }).then(() => setPicked(new Set()))}
          >
            Prepare {picked.size || ""}
          </button>
          <button
            className="quiet"
            disabled={!picked.size || check.running}
            onClick={() => void check.start({ postingIds: ids })}
          >
            Check open
          </button>
          <button className="quiet" disabled={!picked.size} onClick={() => void skip(false)}>
            Skip
          </button>
          {skippedPicked ? (
            <button className="quiet" onClick={() => void skip(true)}>
              Restore
            </button>
          ) : null}
        </div>
      </div>
      <JobStatus job={prep.job} error={prep.error} onCancel={() => void prep.cancel()} />
      <JobStatus job={check.job} error={check.error} onCancel={() => void check.cancel()} />
      {note ? <p role="status">{note}</p> : null}
      {error ? <p role="alert">{error}</p> : null}

      {!data && loading ? <p>Loading postings…</p> : null}
      {data && data.counts.all === 0 ? (
        <div className="empty panel">
          <h2>No postings yet</h2>
          <p>
            Find postings polls the GitHub internship list and the job boards on your watchlist,
            then scores each one against your profile. It takes a minute or two.
          </p>
          <button disabled={refresh.running} onClick={() => void refresh.start()}>
            Find postings
          </button>
        </div>
      ) : null}
      {data && data.counts.all > 0 && data.total === 0 ? (
        <div className="empty panel">
          <p>Nothing matches these filters.</p>
          <button className="quiet" onClick={() => setFilters(DEFAULTS)}>
            Clear filters
          </button>
        </div>
      ) : null}
      {rows.length ? (
        <>
          <table className="queue postings" aria-busy={loading}>
            <thead>
              <tr>
                <th scope="col">
                  <input
                    type="checkbox"
                    aria-label="Select all on this page"
                    checked={allOnPage}
                    onChange={() =>
                      setPicked((s) => {
                        const n = new Set(s);
                        for (const r of rows) {
                          if (allOnPage) n.delete(r.id);
                          else n.add(r.id);
                        }
                        return n;
                      })
                    }
                  />
                </th>
                <th scope="col">Company</th>
                <th scope="col">Role</th>
                <th scope="col">Fit</th>
                <th scope="col">Location</th>
                <th scope="col">Found</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <PostingLine
                  key={r.id}
                  r={r}
                  picked={picked.has(r.id)}
                  onToggle={() => toggle(r.id)}
                  onPrep={() => void prep.start({ postingIds: [r.id] })}
                  busy={prep.running}
                />
              ))}
            </tbody>
          </table>
          <div className="row pager">
            <span className="muted small">
              {offset + 1}–{offset + rows.length} of {data!.total}
            </span>
            <div className="actions">
              <button
                className="quiet"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE))}
              >
                ← Previous
              </button>
              <button
                className="quiet"
                disabled={offset + PAGE >= data!.total}
                onClick={() => setOffset(offset + PAGE)}
              >
                Next →
              </button>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}

function PostingLine({
  r,
  picked,
  onToggle,
  onPrep,
  busy,
}: {
  r: PostingRow;
  picked: boolean;
  onToggle: () => void;
  onPrep: () => void;
  busy: boolean;
}) {
  const found = r.postedAt ?? r.firstSeen;
  return (
    <tr data-closed={!r.isOpen || undefined}>
      <td>
        <input
          type="checkbox"
          aria-label={`Select ${r.company}: ${r.title}`}
          checked={picked}
          onChange={onToggle}
        />
      </td>
      <td>{r.company}</td>
      <td>
        <a href={r.applyUrl} target="_blank" rel="noreferrer noopener">
          {r.title}
        </a>
        {!r.isOpen ? <span className="flag flag-grey">closed</span> : null}
        {r.passed === false && r.filterReasons.length ? (
          <div className="muted small">Filtered out: {r.filterReasons.join("; ")}</div>
        ) : null}
        {r.liveness?.verdict === "uncertain" ? (
          <div className="muted small">Open check unclear: {r.liveness.reason}</div>
        ) : null}
      </td>
      <td>
        {r.tier ? (
          <span className={`tier tier-${r.tier}`}>
            {r.tier} · {r.score}
          </span>
        ) : (
          "–"
        )}
      </td>
      <td className="small">{r.locations.join("; ") || "–"}</td>
      <td className="small">
        {found ? new Date(found).toLocaleDateString() : "–"}
        {r.deadline ? <div className="muted">due {r.deadline}</div> : null}
      </td>
      <td>
        {r.application ? (
          <a href={`#/app/${r.application.id}`}>
            {STATUS_LABEL[r.application.status] ?? r.application.status}
          </a>
        ) : r.isOpen ? (
          <button className="quiet" disabled={busy} onClick={onPrep}>
            Prepare
          </button>
        ) : (
          "–"
        )}
      </td>
    </tr>
  );
}
