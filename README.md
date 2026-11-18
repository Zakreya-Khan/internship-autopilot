# internship-autopilot

A personal, local-first tool that prepares internship applications at volume, then stops one click short of sending each one. It finds postings, scores them for fit, tailors a resume and answers from a single profile, and fills the form in your own browser. **You** press the site's Submit button. The tool never does.

> Status: scaffolding. Nothing runs yet. See the roadmap below.

## Hard limits

These are fixed rules, not settings.

- **Never submits.** No code path clicks a Submit, Apply or Confirm button, or sends an application request.
- **No CAPTCHA or bot-detection bypass.** No solver services, fingerprint spoofing or stealth plugins. You solve those yourself.
- **No account creation and no passwords.** The tool never types into a password or sign-up field.
- **No fabrication.** Every claim must trace to a fact in your profile. A question the profile can't answer truthfully is flagged for you.
- **No platforms whose terms ban automation** (for example LinkedIn Easy Apply). Roles from those sites can be tracked, but you apply by hand.
- **Public sources only, rate-limited.** Job-board APIs are polled at most every 6 hours per board.
- **Sensitive answers never go to the AI model.** EEO, work-authorization and contact fields are filled from your saved choices without passing through Claude.

## How it fits together

```
public sources ──> local app (sourcer → SQLite + profile.yaml → scorer/tailor ⇄ Claude API → review UI)
                                                                                     │ approved apps
                                                                                     v
                         you ── click Submit ──> ATS page <── fills ── Chrome extension
```

- **Local app:** Node + TypeScript, Fastify on `127.0.0.1`, SQLite, React review UI, Typst for PDFs, `@anthropic-ai/sdk`.
- **Chrome extension (MV3):** per-ATS adapters that fill fields, read them back, highlight Submit and detect the confirmation page.
- **Playwright:** a test harness only, replaying adapters against saved HTML fixtures.

## Sources

- [SimplifyJobs/Summer2027-Internships](https://github.com/SimplifyJobs/Summer2027-Internships)
- [Greenhouse Job Board API](https://docs.greenhouse.io/job-board.html) (public GET)
- [Lever Postings API](https://github.com/lever/postings-api) (public GET)
- [Ashby Posting API](https://developers.ashbyhq.com/docs/public-job-posting-api) (public GET)

## Roadmap

| Phase | Scope |
| --- | --- |
| 0 · Setup | `profile.yaml` + answer bank, sourcing + dedupe, SQLite schema, filters + fit scoring |
| 1 · MVP | Tailoring + truth check, review UI + diffs, extension adapters for Greenhouse, Lever, Ashby, tracker + CSV |
| 2 · More ATSs | Workday, SmartRecruiters, iCIMS (best effort), Batch API for routine prep |
| 3 · Polish | Generic fallback adapter, email status sync, Sheets export, outcome analytics |

## Your data

Your real profile lives in `profile.yaml`, which is gitignored. Copy `profile.example.yaml` to start. The database, generated resumes and submission snapshots (`*.sqlite`, `data/`, `out/`, `snapshots/`) are gitignored too. Keep it that way: this repository is public.
