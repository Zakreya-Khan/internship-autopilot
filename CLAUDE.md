# CLAUDE.md

A local-first tool that prepares internship applications and fills them in the user's browser. The user always submits. See README.md for the hard limits, layout and commands.

## Rules for any change

- **Never add a code path that submits an application.** Adapters may _locate_ the final Submit button, to highlight it, but must never click it or send a request to it. The only clicks allowed are in `packages/adapters/src/safe-click.ts` (wizard Next/Continue, a choice button whose text is the answer, opening a listbox), and each one refuses submit-like buttons. ESLint bans `.click()`, `.submit()` and `.requestSubmit()` elsewhere in adapter and extension code; don't disable that rule.
- No CAPTCHA solving, fingerprint spoofing, stealth plugins, account creation, or typing into password fields.
- No fabricated claims: generated text cites profile fact ids, `checkClaims` (code) and `modelTruthCheck` (model) both run, and blocked resume bullets revert to the source wording.
- EEO, work-authorization, contact details and GPA are never sent to the model (`profileForModel` builds the only view the model gets).
- Status changes go through the state machine in `packages/core/src/status.ts`. Only the extension's confirmation or the user can move an application to `submitted`.
- **This repo is public.** Never commit `profile.yaml`, databases, generated resumes, snapshots, exports, real form HTML containing personal data, or `.env`. Fixtures are fictional.
- Database changes: add a new entry to `MIGRATIONS` in `apps/server/src/db.ts`. Never edit a migration that has been committed.

## Stack

TypeScript throughout, npm workspaces: Fastify on 127.0.0.1, SQLite through Node's built-in `node:sqlite`, React + Vite review UI, a Chrome MV3 extension bundled with esbuild, PDFKit for PDFs, `@anthropic-ai/sdk`, Vitest (with happy-dom for DOM tests), and Playwright for end-to-end tests. Default models: `claude-opus-5-5` for drafting and the truth check, and `claude-haiku-5-5` for requirement matching and field mapping.

## Commands

- `npm run check`: typecheck, lint, format check and unit tests. Run it, and pass it, before every commit.
- `npm run test:e2e`: Playwright in real Chromium.
- `npm run build`: the review UI and the extension.
- `npm run ia -- help`: the CLI.
- Tests never call the Claude API: use `FakeLlm` from `@ia/ai` and the fictional fixtures from `@ia/core/testing`.
