# douban-cli

This is a local Douban CLI, derived from Marvae/douban-cli under MIT. Keep the original LICENSE and source attribution. The executable is `douban-cli`; storage is separately namespaced as `douban-cli-local`.

- Use TypeScript ESM and keep command orchestration in `src/commands`, transport and parsing in `src/api`.
- Preserve unknown values as null and report partial reads with metadata and warnings.
- Account edits must read original fields, retain untouched values, check for concurrent changes, POST once, and verify by readback.
- Do not send broadcasts or share to social services during record edits.
- Do not read real cookies or mutate real accounts in tests. Never log cookies or cache keys.
- Keep temporary artifacts in ignored `tmp`, `user`, or `output` directories and clean them before delivery.
- Browser adapters must distinguish native Safari from Playwright WebKit and native Firefox from Playwright Firefox.
- Run `npm run verify`, `git diff --check`, and packaging checks before delivery.
