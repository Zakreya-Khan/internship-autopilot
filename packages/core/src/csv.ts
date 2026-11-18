/** CSV/TSV that Google Sheets and Excel import cleanly. */
export function toDelimited(
  rows: readonly object[],
  columns: string[],
  delimiter: "," | "\t" = ",",
): string {
  const cell = (v: unknown): string => {
    let s = v == null ? "" : Array.isArray(v) ? v.join("; ") : String(v);
    // Spreadsheet formula injection: a cell starting with = + - @ is read as a formula.
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    if (delimiter === "\t") return s.replace(/[\t\r\n]+/g, " ");
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return (
    [
      columns.join(delimiter),
      ...rows.map((r) =>
        columns.map((c) => cell((r as Record<string, unknown>)[c])).join(delimiter),
      ),
    ].join("\r\n") + "\r\n"
  );
}
