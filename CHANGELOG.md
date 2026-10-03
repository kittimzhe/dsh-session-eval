# Changelog

## 0.2.2 — 2026-10-02

Contributor-first docs release.

- Install command fixed to `dsh plugin --profile web add dsh-session-eval` (a global npm install does not mount the slash commands).
- README.zh.md language switch fixed (English link restored, toggle on top); sample outputs bumped to the shipped version.
- Skeleton: one-liner → install → try-once → toolchain table → 6-line contributor block.
- CONTRIBUTING.md (with source map), SECURITY.md, CODE_OF_CONDUCT.md added; GitHub topics set.
- Docs no longer hardcode test counts.


## 0.2.1 — 2026-09-26

- **Fix: ship the bundle overlay.** v0.2.0 declared `dsh.bundle.patch: ./cordis.patch.yml`
  in `package.json` but the file was never committed, so the published tarball did not
  contain it and `dsh web` failed at startup with
  `failed to read overlay .../dsh-session-eval/cordis.patch.yml: ENOENT`.
  The overlay (mounting `/eval`, `/eval-diff`, `/eval-history`) is now in the tarball;
  verified with `npm pack --dry-run`.
- **Fix: peer ranges match the current harness.** `@deepseek-ai/*` peers and dev
  dependencies moved from `^0.1.1-rc.2` to `^0.1.5-rc.3` (semver prerelease ranges do not
  cross `0.1.1-rc.x` → `0.1.5-rc.3`, which let stale `0.1.1-rc.2` copies install into
  profiles and shadow the running harness). `@deepseek-ai/cordis` pinned to `4.0.2`,
  matching the official plugins at this harness level.
- Added this changelog; `files` always listed it but it was never written.

## 0.2.0 — 2026-09-25

- New `/eval-history [N] [--json]` command: lists the current workspace's recent sessions
  (same `sessionQuery` seam as `/archive`), grades the last N, and diffs first-vs-last for
  a trend verdict. Caps the manual id-picking that `/eval-diff` required.
- Version string single-sourced from `src/version.ts` (replaces four hardcoded `v0.1.0`
  strings).
- 8 new tests (35 total) and `typecheck` script.

## 0.1.0 — 2026-09-24

- Initial release: `/eval` grade cards from persisted session logs (tool-error rate,
  follow-up signals, tool load), `/eval-diff` regression comparison, no LLM judge.
