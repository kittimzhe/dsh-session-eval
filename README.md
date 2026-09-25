# dsh-session-eval

English | [中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/dsh-session-eval)](https://www.npmjs.com/package/dsh-session-eval)
[![npm downloads](https://img.shields.io/npm/dw/dsh-session-eval)](https://www.npmjs.com/package/dsh-session-eval)
[![tests](https://github.com/kittimzhe/dsh-session-eval/actions/workflows/test.yml/badge.svg)](https://github.com/kittimzhe/dsh-session-eval/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Retrospective evaluation for DeepSeek Harness agent sessions** — deterministic grade cards computed from sessions that already happened, plus cross-session regression diffs that answer *"did my agent get better or worse after that plugin / prompt / model change?"*

No benchmark suites to author. No LLM judges. No new runs. Every grade is a fixed, documented threshold over persisted session logs — fully reproducible.

## The measurement layer of the session toolchain

| Plugin | Layer | Answers |
|---|---|---|
| [`dsh-session-export`](https://www.npmjs.com/package/dsh-session-export) | Evidence | "What exactly happened in this session?" |
| [`dsh-session-recall`](https://www.npmjs.com/package/dsh-session-recall) | Memory | "What did I do before, and where is it?" |
| **`dsh-session-eval`** | **Measurement** | **"Was that session good? Is the trend improving?"** |

All three read through the same trusted `ctx.sessionQuery` seam, so any persistence backend (JSONL or SQLite) works without touching raw artifacts.

## How it differs from benchmark-style evaluation

| | `dsh-eval` (benchmark) | `dsh-session-eval` (this) |
|---|---|---|
| Evaluates | Runs you launch ahead of time | Sessions that already happened |
| Setup | Author benchmark YAML + cases | None — read existing logs |
| Judge | Metric folding over trials | Fixed thresholds, deterministic |
| Best at | Pre-deploy benchmarks | Regression tracking over real work |

Both are useful; they don't compete. Benchmarks test what you *predicted*; retrospective evaluation watches what *actually happened*.

## Quick Start

```bash
npm install -g dsh-session-eval
```

Then in DeepSeek Harness:

```text
/eval
```

```text
Session eval — a1b2c3d4… (dsh-session-eval v0.2.0)
Overall: A
  Reliability   A    2/87 tool results errored (2.3%)
  Re-ask        A    1 re-ask signal(s) over 23 turns (0.4/10 turns)
  Tool load     B    3.8 tool calls per turn
Notes:
  • Wall time 41.2 min over 23 turns.
```

Grade another session, or emit machine-readable JSON:

```text
/eval --id <sessionId> --json
```

Compare two sessions — the regression workflow:

```text
/eval-diff <beforeSessionId> <afterSessionId>
```

```text
Session diff — a1b2c3d4… → e5f6a7b8… (dsh-session-eval v0.2.0)
Overall: regressed — 0 improved, 2 regressed, 1 flat.
  Reliability   2.1% → 11.8%   regressed
  Re-ask        0.5 → 3.2      regressed
  Tool load     3.8 → 4.1      flat
```

Typical use: grade the ten sessions before and after a plugin or prompt change; a persistent `Reliability` regression is an early warning that the change hurt real work, not just benchmarks.

See the whole trend — no ids to hunt for:

```text
/eval-history        # last 5 sessions in this workspace
/eval-history 12     # last 12
```

```text
Session history — last 5 in this workspace
  2026-09-20 14:02  a1b2c3d4…  B   4 turns, 9 tools
  2026-09-21 09:15  c3d4e5f6…  A   5 turns, 11 tools
  2026-09-22 17:44  e5f6a7b8…  A   3 turns, 7 tools
Trend (first → last): improved — 2 improved, 0 regressed, 1 flat.
```

`/eval-history` finds the sessions for you via the same `sessionQuery` seam `/archive` uses (scoped to the current workspace's `cwd`), grades each, and diffs the first against the last. `/eval-diff` remains the tool when you already know the two ids that matter.

## Dimensions & thresholds

All grades derive from three deterministic metrics. `n/a` when the session lacks the relevant activity.

| Dimension | Metric | A | B | C | D | E |
|---|---|---|---|---|---|---|
| Reliability | tool error rate | ≤5% | ≤10% | ≤20% | ≤35% | >35% |
| Re-ask | corrections per 10 turns¹ | 0 | <1 | <2 | <4 | ≥4 |
| Tool load | tool calls per turn | 0.5–8 | 0.1–0.5 or just above 8 | <0.1 or 8–20 | >20 | — |

¹ A *correction signal* is each extra user message inside a consecutive-user run — the human re-asking before any assistant reply, a behavioral proxy for "the agent didn't get it right the first time."

`Overall` is the **worst** graded dimension — conservative by design. Thresholds are constants in [`src/grade.ts`](src/grade.ts); they will be configurable in a future release.

Diff verdicts include a noise band (±2pp error rate, ±0.5 re-ask, ±1 tool load) so trivial jitter doesn't cry regression.

## Determinism guarantee

Same session logs in → same grade card out, every time, forever. There is no model in the loop, no sampling, no clock dependence in the metrics (wall time is reported, never graded). This is what makes `/eval-diff` trustworthy as a regression signal.

## Commands

| Command | Effect |
|---|---|
| `/eval` | Grade card for the current session |
| `/eval --id <sessionId>` | Grade a specific session |
| `/eval --json` | Machine-readable metrics + card |
| `/eval-diff <beforeId> <afterId>` | Regression comparison, noise-tolerant |
| `/eval-diff … --json` | Machine-readable trend report |
| `/eval-history [N]` | Grade the last N sessions in this workspace and show the trend |
| `/eval-history … --json` | Machine-readable history report |

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run — 24 tests
npm run bundle      # tsdown → lib/
```

## License

[MIT](LICENSE)
