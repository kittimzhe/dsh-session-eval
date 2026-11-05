## 0.4.1 — 2026-11-05

Peer-range compatibility release (no behavior change).

- `@deepseek-ai/dsh-*` peers widened to `^0.1.5-rc.3 || ^0.2.0 || 0.2.2-rc.1` and `@deepseek-ai/cordis` to `^4.0.2`, ahead of the DSH 0.2.2 release train.
- Verified against `@deepseek-ai/*@0.2.2-rc.1` in a scratch install: full suite 60/60 green. Notably `SESSION_FORMAT_VERSION` moved 3 → 4 upstream; a v3-header archive still round-trips through the 0.2.2 `buildArchiveFromLog` (historical formats are translated), so existing exported bundles keep grading identically.

## 0.4.0 — 2026-11-05

Evidence-handoff closure (#8): `/eval --report <bundle-or-archive.zip>`.

- Grades straight from an exported dsh-session-export artifact — bundle ZIPs (nested archive.zip) and raw /archive ZIPs — no session id to copy, and it works after the session is gone from the store.
- The artifact's JSONL is the canonical event log, so `--report` matches `/eval --id` exactly; a round-trip test builds bundles with the real dsh-session-export writer and asserts identical metrics and cards.
- Zero runtime dependencies kept: a minimal ZIP reader (central directory + raw DEFLATE via node:zlib, CRC32-verified) mirrors the export writer; dsh-session-export is a devDependency only, for the interop test.
- README.md / README.zh.md document the recall → report → eval closure with a worked example.

## 0.3.0 — 2026-10-23

Feature release: configurable grade bands (#1) and the history time window (#2).

- New: a `gradeBands` config block overrides the default thresholds for any dimension, per-profile — `reliability` in error-rate percent, `reask` in corrections per 10 user turns, `toolLoad` as `[lowC, lowB, highC, highD]` calls per turn. Invalid config (unknown keys, wrong arity, non-numeric, negative, non-ascending) fails fast at plugin load with a readable error; defaults are unchanged when nothing is configured.
- New: `/eval-history --since 24h|7d|30d` grades only sessions whose latest activity falls inside the window — filtered by last event time, not creation time. An empty window prints a clear message; without the flag the behavior is exactly as before.

## 0.2.4 — 2026-10-11

Feature release: eval-history report files.

- New: `/eval-history --out PATH[.md|.json]` writes the history report to a Markdown or JSON file instead of only echoing it (contributed by @varshith84 in #4, merged as 117f918 after a maintainer rebase).

# Changelog


## 0.2.3 — 2026-10-03

Docs polish round (no runtime changes).

- Install detail completed: requirements, GitHub install route, the `cordis.patch.yml` row.
- Contributor block links the open-gap issues directly; sample outputs aligned with the shipped version.
- Community section; bilingual issue templates (`.github/ISSUE_TEMPLATE/`).
- English/Chinese README sections kept in sync.

## 0.2.2 — 2026-10-02

Contributor-first docs release.

- Install command fixed to `dsh plugin --profile web add dsh-session-eval` (a global npm install does not mount the slash commands).
- README.zh.md language switch fixed (English link restored, toggle on top); sample outputs bumped to the shipped version.
- Skeleton: one-liner → install → try-once → toolchain table → 6-line contributor block.
- CONTRIBUTING.md (with source map), SECURITY.md, CODE_OF_CONDUCT.md added; GitHub topics set.
- Docs no longer hardcode test counts.
- Install details (GitHub route + `cordis.patch.yml`), Development/Community footers, and issue links #1–#3 added for parity with the sibling plugins.
- GitHub issue templates (`bug_report`, `feature_request`) added.


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
