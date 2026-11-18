import type { ResumeDiff } from "@ia/core";

const LABEL: Record<string, string> = {
  kept: "Kept",
  reworded: "Reworded",
  added: "Added",
  removed: "Removed",
};

export function ResumeDiffView({ diff }: { diff: ResumeDiff }) {
  const { summary } = diff;
  return (
    <section aria-label="Resume changes">
      <p className="muted">
        {summary.reworded} reworded · {summary.added} added · {summary.removed} removed ·{" "}
        {summary.kept} kept
      </p>
      <ul className="diff">
        {diff.bullets.map((b, i) => (
          <li key={i} className={`diff-${b.status}`}>
            <span className="badge" data-status={b.status}>
              {LABEL[b.status]}
              {b.moved !== 0 ? ` · moved ${b.moved < 0 ? "up" : "down"} ${Math.abs(b.moved)}` : ""}
            </span>{" "}
            {b.status === "reworded" && b.words ? (
              <span>
                {b.words.map((w, j) =>
                  w.added ? (
                    <ins key={j}>{w.value}</ins>
                  ) : w.removed ? (
                    <del key={j}>{w.value}</del>
                  ) : (
                    <span key={j}>{w.value}</span>
                  ),
                )}
              </span>
            ) : (
              <span>{b.variant ?? b.base}</span>
            )}
            <span className="facts" title="Facts this bullet cites">
              {b.factIds.join(", ")}
            </span>
          </li>
        ))}
      </ul>
      {(diff.skillsMoved.length > 0 || diff.skillsDropped.length > 0) && (
        <p className="muted">
          Skills:{" "}
          {diff.skillsMoved.map((m) => `${m.skill} ${m.to < m.from ? "up" : "down"}`).join(", ")}
          {diff.skillsDropped.length ? ` · dropped ${diff.skillsDropped.join(", ")}` : ""}
        </p>
      )}
    </section>
  );
}
