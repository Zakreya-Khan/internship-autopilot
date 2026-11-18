# CLAUDE.md

A local-first tool that prepares internship applications and fills them in the user's browser. The user always submits. See README.md for the hard limits and architecture.

## Rules for any change

- **Never add a code path that submits an application.** Adapters may *locate* the final Submit button, to highlight it, but must never click it or send a request to it. Wizard "Next" buttons, such as Workday's step navigation, are allowed. The final Submit, Apply or Confirm is not.
- No CAPTCHA solving, fingerprint spoofing, stealth plugins, account creation, or typing into password fields.
- No fabricated claims: generated text must cite profile fact ids, and a second pass rejects anything it can't trace.
- EEO, work-authorization and contact fields are never sent to the model.
- **This repo is public.** Never commit `profile.yaml`, databases, generated resumes, snapshots, real form fixtures that contain personal data, or `.env`. Test fixtures use fictional data only.

## Stack (planned)

TypeScript throughout: Fastify on 127.0.0.1, SQLite (`better-sqlite3`), React + Vite review UI, a Chrome MV3 extension, Typst for PDFs, `@anthropic-ai/sdk`, and Playwright as a test harness. Default model is `claude-opus-5-5` for drafting and checks, and `claude-haiku-5-5` for bulk scoring and field mapping.
