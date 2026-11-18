# internship-autopilot

A personal, local-first tool that prepares internship applications at volume and stops one click short of sending each one. It finds postings, scores them for fit, tailors a resume and answers from a single profile, and fills the form in your own browser. **You** press the site's Submit button. The tool never does.

All four phases from the spec are built: sourcing and scoring, tailoring with a truth check, the review UI and Chrome extension, Workday and the other ATSs, the Batch API, a generic adapter, email status sync, export and outcome stats. Ported from [career-ops](https://github.com/career-ops-hq/career-ops) (MIT, see [NOTICE](NOTICE)): a check that each posting is still open, writing rules against AI-sounding text, Workday and SmartRecruiters as sources, an interview story bank, and outreach drafts. See [What's verified](#whats-verified-and-what-isnt) before relying on it.

## Hard limits, and how the code enforces them

| Limit                                 | Enforcement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Never submits                         | An ESLint rule bans `.click()`, `.submit()` and `.requestSubmit()` in adapter and extension code. The one allowed click helper refuses anything that reads like Submit, Apply or Confirm. Tests check that fixture forms never fire `submit`. The API marks an application submitted only after the extension filled it, and only when the confirmation page is seen or you confirm it.                                                                                                                                       |
| No CAPTCHA or bot-detection bypass    | No solver, no stealth code. The extension runs in your normal Chrome with no WebDriver or CDP session. You solve any check yourself.                                                                                                                                                                                                                                                                                                                                                                                          |
| No accounts or passwords              | Password fields are never listed or filled, and any question labelled password, passcode or access code is left for you. Workday and iCIMS sign-in screens pause filling until you've signed in yourself.                                                                                                                                                                                                                                                                                                                     |
| No fabrication                        | Every resume bullet must cite fact ids from `profile.yaml`. Code rejects uncited claims, numbers not in a verified fact, technologies not in your profile, and inflated skill levels. A separate Claude pass then checks every draft against its cited facts. A blocked bullet falls back to your own wording; a blocked answer is flagged for you. Interview stories pass a code check that every number appears in a fact they cite.                                                                                        |
| No AI-sounding text                   | Code checks every generated text for stock AI words and phrases, em dashes and "not X but Y" constructions (`packages/core/src/writing.ts`). A draft that breaks them is redrafted once; what's left is treated like a truth-check failure. Writing samples shape only cover letters and answers, as numbers; their text is never sent or copied. With `style.resume_wording: original` your bullets are never reworded, and with `style.cover_letter_base` every cover letter is your own letter plus one checked paragraph. |
| No wasted work on closed postings     | Before prep and before the fill session opens an approved application, each board's public API (or the page) is asked whether the posting is still open. Only a definitive answer (HTTP 404/410, a closed banner) closes it; anything unclear keeps it. Closed results are stored and never come back.                                                                                                                                                                                                                        |
| Sensitive answers never go to a model | EEO, work authorization, contact details and GPA are filled from your saved choices. Tests assert they never appear in a model request, through the API or the Claude CLI.                                                                                                                                                                                                                                                                                                                                                    |
| Platforms that ban automation         | No LinkedIn or Handshake code. Unknown sites need your explicit per-site permission. Outreach messages are drafts you send yourself. A site that turns automated clients away (Workday answers HTTP 429) is left alone for the run; the tool doesn't disguise itself to get past it.                                                                                                                                                                                                                                          |
| Polite to public APIs                 | Requests to each host are spaced 1 second apart, with retries and backoff. Boards are polled every 6 hours. A per-company cap (default 3) limits how many roles you apply to at one company.                                                                                                                                                                                                                                                                                                                                  |

## Quick start

Requirements: Node 22.13 or later (24 recommended), and Chrome 116 or later.

```bash
npm install
npm run ia -- init          # creates profile.yaml (gitignored), the data folder and your extension token
```

1. Fill in `profile.yaml`: facts with ids, skills with honest levels, work authorization, EEO choices (`decline` is fine), and your preferences.
2. For tailored drafts, give it a way to reach Claude: an Anthropic API key (`ANTHROPIC_API_KEY`), or the Claude Code CLI on your Claude subscription. See [Reaching Claude](#reaching-claude-api-key-or-claude-cli). Without either, everything runs offline: keyword scoring, your base resume, and open questions left for you.
3. Find and prepare applications:

```bash
npm run ia -- refresh       # poll sources, score, fetch details, rescore
npm run ia -- list --tier A
npm run ia -- check-open    # are the top candidates still open? closed ones are dropped for good
npm run ia -- prep --limit 10
```

4. Build and start the review UI:

```bash
npm run build
npm run ia -- serve         # http://127.0.0.1:4317
```

5. Load the extension: open `chrome://extensions`, turn on Developer mode, choose "Load unpacked", and pick `apps/extension/dist`. On its options page, paste the token from `init`.
6. In the UI, review and approve applications. In the extension's side panel, press **Start session**. Each approved application opens filled; you check it, solve any CAPTCHA, and press the site's own Submit. The session then moves to the next one.

## Commands

| Command                                    | What it does                                                                                                                        |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `init`                                     | Create `profile.yaml`, the data folder and the API token                                                                            |
| `source` / `score` / `enrich` / `refresh`  | Poll public sources, filter and fit-score, fetch descriptions and Greenhouse forms. `refresh` runs all of them.                     |
| `list [--tier A] [--limit N]`              | Ranked candidates                                                                                                                   |
| `check-open [URL ...] [--limit N]`         | Ask each job board whether the top N candidates (or the URLs given) are still open. Closed ones are recorded and never come back.   |
| `prep [--limit N] [--tier A,B] [--sonnet]` | Check each posting is open, then tailor, truth-check, writing-check, render PDFs and build fill plans. `--no-open-check` skips it.  |
| `serve [--port N] [--auto] [--batch]`      | Review UI and extension API on 127.0.0.1. `--auto` refreshes and preps every 6 h; `--batch` sends Tier B drafting to the Batch API. |
| `stories [--count N]`                      | Interview story bank (STAR) from your facts, in `data/stories.md`. Every number must appear in a fact the story cites.              |
| `outreach <posting> [--to referral]`       | A three-sentence recruiter or referral message under 300 characters, for you to send yourself. Never sent.                          |
| `batch submit` / `batch collect`           | Tier B drafting through the Message Batches API at half price                                                                       |
| `stats`                                    | Reply rates by tier, score band, source and ATS; what's due; suggestions                                                            |
| `export [--format csv\|tsv]`               | Tracker export for Google Sheets or Excel                                                                                           |
| `email-sync <mbox\|folder> [--dry-run]`    | Update statuses from a local email export. Rule-based; nothing leaves your machine.                                                 |
| `cost`                                     | Model spend so far, from logged usage. Claude CLI calls are listed apart, as estimates your subscription covers.                    |

Add `--offline` to any command to keep it from calling Claude, or `--provider api|cli` to choose how it reaches Claude for that run.

## How it fits together

```
public sources ─▶ local app (sourcer → SQLite + profile.yaml → scorer/tailor ⇄ Claude API → review UI)
                                                                                   │ approved
                                                                                   ▼
                       you ─ click Submit ─▶ ATS page ◀─ fills ─ Chrome extension (side panel)
```

| Path                | What it holds                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core`     | Profile schema, ATS URLs, dedupe, filters, fit score, form-question rules, fill plans, resume model and diff, truth checks, status machine, analytics, email rules, CSV export |
| `packages/sources`  | Fetchers for SimplifyJobs `listings.json` and the Greenhouse, Lever, Ashby, Workday and SmartRecruiters public APIs, the open-posting check, and a rate limiter                |
| `packages/ai`       | Claude client (structured output, cached profile prefix, refusal fallback), requirement matching, drafting, truth check, field matching, Batch API                             |
| `packages/render`   | One-page resume and cover letter PDFs, plus the text-extraction parse check                                                                                                    |
| `packages/adapters` | DOM fill engine and adapters: Greenhouse, Lever, Ashby, Workday, SmartRecruiters, iCIMS, generic                                                                               |
| `apps/server`       | `node:sqlite` store, pipeline, prep, batch, email sync, Fastify API, CLI                                                                                                       |
| `apps/ui`           | React review queue, detail view with diff and flags, tracker, stats                                                                                                            |
| `apps/extension`    | Manifest V3 extension: side panel session, background controller, content script                                                                                               |
| `fixtures/forms`    | Fictional forms modeled on each ATS, used in tests                                                                                                                             |
| `e2e`               | Playwright tests in real Chromium                                                                                                                                              |

Models: `claude-opus-5-5` drafts (effort `medium` for Tier B, `high` for Tier A) and runs the truth check (effort `low`). `claude-haiku-5-5` handles requirement matching and field mapping. Tier B can use `claude-sonnet-5-5` with `--sonnet`.

## Reaching Claude: API key or Claude CLI

Pick one in the review UI under **Settings**, or per command with `--provider api|cli`. The choice is saved in your local database under `data/`.

|                 | Anthropic API key                                                                                                                                                             | Claude CLI (subscription)                                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Set up          | `ANTHROPIC_API_KEY` in your environment, or paste a key in Settings (saved to `data/anthropic-api-key`, readable only by you, never shown again beyond its last 4 characters) | Install Claude Code and sign in once by running `claude` in a terminal. It's found on `PATH` or in the usual install folders; Settings can take an explicit path. |
| Billing         | Per token, on your API account                                                                                                                                                | Covered by your subscription. `cost` and Stats show CLI calls as estimates, apart from API spend.                                                                 |
| Tier B drafting | Batch API at half price (`batch`, `serve --auto --batch`)                                                                                                                     | No Batch API: Tier B is prepared one at a time, and `batch` says so.                                                                                              |
| Usage limits    | API rate limits                                                                                                                                                               | When the subscription's limit is hit, prep pauses and says so; unfinished applications go first next run. Nothing retries in a loop.                              |

Settings shows whether a key is found, and whether the CLI is installed, its version and whether it's signed in. **Test connection** makes one tiny Haiku call.

Both providers get the same request text. The CLI runs as `claude -p --output-format json --json-schema …`, from an argv array (no shell), with no tools, no MCP servers, no settings files and no saved session. It starts in an empty temp folder, so no `CLAUDE.md` or project file is read, and API credentials are removed from its environment so it uses your subscription.

## What's verified, and what isn't

Last full run: 2026-11-18 (second end-to-end pass, with live Claude calls).

- **Verified against live public data:** the SimplifyJobs feed, the Greenhouse, Lever and Ashby list and detail APIs, the SmartRecruiters postings API, and the Workable and BambooHR job APIs used by the open check (a real company's internships came back and merged with the same jobs from SimplifyJobs by job id). The open-posting check was run on real postings: closed ones on Greenhouse, Lever, Ashby and SmartRecruiters were reported closed and open ones open, matching SimplifyJobs.
- **Read-only mapping of live forms:** eight real Greenhouse, Lever and Ashby application forms over two runs, with fields detected, a fill plan built from a real profile and the extension's field-mapping rules applied to every field on the page, without typing or submitting. The runs found and fixed: Lever pages taken for Greenhouse, live Ashby pages exposing only the resume-autofill box, a "Website Password" question planned as a link, Lever and Ashby custom questions read without their question text, Greenhouse's hidden react-select inputs listed as blank required fields, "Preferred First Name" taken for a referral question, a two-decimal GPA matching no range option, and "decline" not matching "Not Declared".
- **Verified in tests:** every adapter against fictional fixture forms, in happy-dom and in real Chromium. `e2e/extension.spec.ts` loads the built extension into Chromium and runs a whole session across Greenhouse, Lever, Ashby, Workday, SmartRecruiters, iCIMS and the generic filler: Start in the side panel, the extension fills each form, the test plays you pressing Submit, and the tracker shows each one submitted. A posting that closed after approval is skipped and reported. The generic case pre-grants its test site, since a test can't answer Chrome's permission prompt.
- **Workday from this tool:** Workday's public jobs endpoint answers curl but returns HTTP 429 to Node's HTTP client, so live Workday sourcing, descriptions and open checks don't work yet. The code stops asking for the rest of the run, and Workday postings found through SimplifyJobs are kept (their open check says "unclear"). The Workday source is covered by tests against recorded response shapes only.
- **Not yet verified on live forms:** Workday, SmartRecruiters and iCIMS forms; fixtures are modeled on each platform's structure, not copied. Lever's and Ashby's custom questions aren't in their public APIs, so they're never drafted: the extension maps the ones your profile answers and leaves the rest for you. Watch the first real submissions on every platform.
- **Claude API, live:** requirement matching (Haiku), drafting (Opus, and Haiku when there's nothing to write), the truth check, the added cover-letter paragraph, PDF rendering and `cost` ran on real postings: resumes came out one page and passed the parse check, and the truth check caught claims taken from the cover letter but not in the profile. `stories` and `outreach` have only run against the fake. Tests never call the API.
- **Claude CLI provider:** tested against a fake `claude` binary: the exact argv, stdin, empty working folder, removed credentials, JSON parsing, one retry on a malformed answer, the usage-limit pause, and that every model call sends the CLI exactly what the API path sends, with no sensitive values. Live, against Claude Code 2.1.325: the flags parse, Settings reads its version and sign-in, and a missing or signed-out CLI stops prep once with a clear message. A signed-in CLI call has not run yet. Through the API provider, `prep --provider api` and Test connection ran live.
- **Email sync** reads exported mail only. There is no Gmail API sign-in, by design.

## Development

```bash
npm run check        # typecheck, lint, format check, unit tests (run before every commit)
npm run test:e2e     # Playwright, real Chromium (npx playwright install chromium first)
npm run build        # review UI + extension
```

CI runs all of the above, plus `npm audit --omit=dev`. Tests never call the Claude API: use `FakeLlm` from `@ia/ai`, and the fictional fixtures from `@ia/core/testing`.

## Your data

Your real profile lives in `profile.yaml`, which is gitignored; `profile.example.yaml` shows the format. Keep writing samples under `data/` too. The database, generated resumes, submission snapshots and exports live under `data/`, which is gitignored too. Everything stays on your machine except two kinds of outbound traffic: reads of public job boards, and Claude requests (through the API or the Claude CLI) that carry only skills, facts and posting text. This repository is public, so keep it that way.
