# douban-cli Agent Guide

## Project overview

`douban-cli` is a Node.js 22+ TypeScript ESM command-line application built with Commander. Source code lives in `src/`; `npm run build` emits the executable package to `dist/`.

Start with:

- `src/index.ts` for command registration and root help.
- `README.md` for current user-visible commands and behavior.
- `package.json` for the supported toolchain and verification pipeline.

## Runtime flows

Public reads:

```text
src/index.ts -> commands/* -> api/* -> api/common.ts -> api/http/* -> decoder/parser -> terminal or JSON output
```

Authenticated writes:

```text
commands/* -> src/auth.ts -> cached account verification -> api/authenticated.ts -> Douban
```

Exports:

```text
commands/* -> collection/authenticated API -> serializer -> storage/secure-file.ts
```

## Repository map

- `src/index.ts` — CLI composition root. Creates the Commander program, formats root help, and registers command groups.
- `src/commands/` — CLI arguments, validation, orchestration, pagination, and terminal/JSON presentation.
  - `movie.ts` — movie and TV discovery, search, details, ratings, comments, and reviews.
  - `book.ts` — book charts, search, details, ratings, comments, reviews, and notes.
  - `book-collection.ts` — public book collections and Markdown/CSV/JSON export.
  - `user.ts` — movie collections, `me`, and local user configuration.
  - `auth.ts` — login, identity display, and logout commands.
  - `mark.ts` / `social.ts` — account mutations, feed, statistics, and private exports.
- `src/api/` — Douban URLs, response validation, domain parsing, and API result types. It must not render terminal output.
  - `http/` — timeout, redirect, retry, content-type, and structured transport errors for public reads.
  - `common.ts` — shared read client and HTML/text helpers.
  - `movie.ts`, `book.ts`, `search.ts`, `list.ts` — domain-specific read APIs.
  - `book-parsers.ts` — pure book HTML parsers.
  - `subject.ts` — behavior genuinely shared by movies and books, such as ratings, comments, and reviews.
  - `collection.ts` — shared movie/book collection parsing and cursor-based pagination.
  - `authenticated.ts` — session validation and non-idempotent account endpoints.
  - `user.ts` — compatibility wrapper for older movie collection callers.
- `src/auth.ts` — browser-cookie login, account selection, identity verification, and encrypted auth cache.
- `src/storage/secure-file.ts` — atomic private-file writes with restrictive permissions.
- `src/utils/` — domain-independent errors, pagination, parsing, spinner, debug, and timing helpers.
- `src/__tests__/` — API, parser, command, authentication, pagination, and secure-file tests.
- `scripts/` — post-build executable handling and CLI smoke tests.
- `.github/workflows/` — CI and GitHub Release-driven npm publishing.
- `skills/` — source artifacts for external skill registries; not runtime code and not included in the npm package.

## Where to make changes

- Command names, options, help, or presentation: change the relevant file in `src/commands/`; register new top-level groups in `src/index.ts`.
- Douban HTML or JSON schema changes: change the owning `src/api/` module or parser and add a focused fixture/decoder test.
- Movie/book shared ratings, comments, reviews, or collections: use `subject.ts` or `collection.ts` only when both domains have the same contract.
- Timeout, retry, redirect, challenge, or content-type behavior: change `src/api/http/` and `api-reliability.test.ts`.
- Login, Cookie, or account mutations: change `src/auth.ts`, `src/api/authenticated.ts`, or `src/storage/`; tests must use mocks.
- Interactive pagination: change `src/utils/pagination.ts` and the command's page loader.
- User-visible behavior: update `README.md` and the relevant CLI smoke or command test.
- External skill packaging: update `skills/douban-cli/`; derive command behavior from the CLI, README, and tests.

## Architectural invariants

- `src/commands/` does not call `fetch` directly.
- Only idempotent reads may be retried automatically; account writes must not be blindly retried.
- Treat all Douban HTML and JSON as untrusted input and validate it at the API boundary.
- Preserve successfully fetched pages or fields when a later source fails; surface partial results with warnings.
- Keep movie- and book-specific behavior separate until at least two concrete consumers share the same contract.
- Commands supporting `--json` must render structured failures to stderr as well as structured successes to stdout.
- Non-TTY execution must not enter interactive pagination.
- Tests must not read real browser Cookies or perform real authenticated mutations.
- Code comments are English; user-facing CLI text may be Chinese.

## Verification

Run before committing:

```bash
npm run verify
git diff --check
```

For packaging changes, also run:

```bash
npm pack --dry-run --ignore-scripts
```
