import { useEffect, useState } from "react";
import type { ConnectionTest, Provider, ProviderSettings } from "../api.ts";
import { api } from "../api.ts";

const PROVIDERS: Provider[] = ["api", "cli"];

function apiStatus(s: ProviderSettings): string {
  if (!s.api.available) return "No key found. Set ANTHROPIC_API_KEY, or paste one below.";
  const where = s.api.source === "environment" ? "from ANTHROPIC_API_KEY" : "saved in data/";
  return `Key found ${where}${s.api.hint ? ` (${s.api.hint})` : ""}.`;
}

function cliStatus(s: ProviderSettings): string {
  if (!s.cli.found) return s.cli.problem ?? "Claude CLI not found.";
  const v = s.cli.version ? `version ${s.cli.version}` : "version unknown";
  const signed =
    s.cli.signedIn === true
      ? `signed in${s.cli.authMethod ? ` (${s.cli.authMethod})` : ""}`
      : s.cli.signedIn === false
        ? 'not signed in: run "claude" once in a terminal and sign in'
        : "sign-in unknown";
  return `Found at ${s.cli.path}, ${v}, ${signed}.`;
}

function ok(s: ProviderSettings, p: Provider): boolean {
  return p === "api" ? s.api.available : s.cli.found && s.cli.signedIn !== false;
}

export function Settings() {
  const [s, setS] = useState<ProviderSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tests, setTests] = useState<Partial<Record<Provider, ConnectionTest | "running">>>({});
  const [key, setKey] = useState("");
  const [cliPath, setCliPath] = useState("");

  const run = async (f: () => Promise<ProviderSettings>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await f();
      setS(next);
      setCliPath(next.cliPath ?? "");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void run(api.providerSettings);
  }, []);

  const test = async (p: Provider) => {
    setTests((t) => ({ ...t, [p]: "running" }));
    try {
      const r = await api.testProvider(p);
      setTests((t) => ({ ...t, [p]: r }));
    } catch (e) {
      setTests((t) => ({ ...t, [p]: { ok: false, error: (e as Error).message } }));
    }
  };

  if (!s) return error ? <p role="alert">{error}</p> : <p>Checking how Claude can be reached…</p>;
  return (
    <section>
      <h1>Settings</h1>
      {error ? <p role="alert">{error}</p> : null}
      <section className="panel">
        <h2>How to reach Claude</h2>
        <p className="muted">
          Both options get exactly the same text: your facts and skills, never your contact details,
          EEO answers, work authorization or GPA. The choice is saved in your local database
          (data/), and <code>--provider api|cli</code> overrides it for one command.
        </p>
        <fieldset disabled={busy}>
          <legend className="sr-only">Provider</legend>
          {PROVIDERS.map((p) => {
            const t = tests[p];
            return (
              <div key={p} className="panel" data-provider={p}>
                <label>
                  <input
                    type="radio"
                    name="provider"
                    value={p}
                    checked={s.selected === p}
                    onChange={() => void run(() => api.setProvider({ provider: p }))}
                  />{" "}
                  <strong>{s.labels[p]}</strong>
                </label>
                <p className={ok(s, p) ? "ok" : "warn"}>
                  {p === "api" ? apiStatus(s) : cliStatus(s)}
                </p>
                <div className="actions">
                  <button
                    type="button"
                    className="quiet"
                    disabled={t === "running" || !ok(s, p)}
                    onClick={() => void test(p)}
                  >
                    {t === "running" ? "Testing…" : "Test connection"}
                  </button>
                  {t && t !== "running" ? (
                    <span role="status" className={t.ok ? "ok" : "warn"}>
                      {t.ok ? `Works (${t.model}, ${(t.ms / 1000).toFixed(1)} s).` : t.error}
                    </span>
                  ) : null}
                </div>
                {p === "api" ? (
                  <form
                    className="row"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const k = key;
                      setKey("");
                      void run(() => api.saveApiKey(k));
                    }}
                  >
                    <label className="settings-field">
                      <span className="sr-only">Paste an Anthropic API key</span>
                      <input
                        type="password"
                        autoComplete="off"
                        placeholder="Paste a key to save it in data/ (optional)"
                        value={key}
                        onChange={(e) => setKey(e.target.value)}
                      />
                    </label>
                    <button type="submit" disabled={!key.trim()}>
                      Save key
                    </button>
                    {s.api.source === "saved" ? (
                      <button
                        type="button"
                        className="quiet"
                        onClick={() => void run(api.forgetApiKey)}
                      >
                        Forget saved key
                      </button>
                    ) : null}
                  </form>
                ) : (
                  <>
                    <form
                      className="row"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void run(() => api.setProvider({ cliPath: cliPath.trim() || null }));
                      }}
                    >
                      <label className="settings-field">
                        <span className="sr-only">Path to the claude command</span>
                        <input
                          placeholder="Path to claude (blank: find it automatically)"
                          value={cliPath}
                          onChange={(e) => setCliPath(e.target.value)}
                        />
                      </label>
                      <button type="submit" className="quiet">
                        Save path
                      </button>
                    </form>
                    <ul className="muted small">
                      <li>
                        Uses your Claude subscription; spend shows as an estimate, not billed.
                      </li>
                      <li>
                        No Batch API: Tier B drafts are prepared one at a time instead of at half
                        price overnight.
                      </li>
                      <li>
                        If your subscription's usage limit is reached, prep pauses and tells you;
                        run it again after the limit resets.
                      </li>
                    </ul>
                  </>
                )}
              </div>
            );
          })}
        </fieldset>
        <p className={s.ready ? "ok" : "warn"} role="status">
          {s.ready
            ? `In use: ${s.labels[s.selected]}.`
            : `${s.labels[s.selected]} isn't ready: ${s.reason}`}
        </p>
      </section>
    </section>
  );
}
