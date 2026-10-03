# dsh-session-eval

English | [中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/dsh-session-eval)](https://www.npmjs.com/package/dsh-session-eval)
[![npm downloads](https://img.shields.io/npm/dw/dsh-session-eval)](https://www.npmjs.com/package/dsh-session-eval)
[![tests](https://github.com/kittimzhe/dsh-session-eval/actions/workflows/test.yml/badge.svg)](https://github.com/kittimzhe/dsh-session-eval/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Retrospective evaluation for DeepSeek Harness agent sessions** — deterministic grade cards computed from sessions that already happened, plus cross-session regression diffs that answer *"did my agent get better or worse after that plugin / prompt / model change?"*

No benchmark suites to author. No LLM judges. No new runs. Every grade is a fixed, documented threshold over persisted session logs — fully reproducible.

## Install

**Requirements**: Node.js 20 or 22 · a DeepSeek Harness profile that mounts the `commands` and `sessionQuery` services (the shipped `web` / `agent` profiles qualify).

```bash
dsh plugin --profile web add dsh-session-eval
```

Or from GitHub:

```bash
dsh plugin --profile web add github:kittimzhe/dsh-session-eval
```

The bundle overlay mounts `/eval`, `/eval-diff`, and `/eval-history`. If you maintain your own `cordis.patch.yml`, keep this row:

```yaml
- insert:
    - id: session-eval
      name: 'dsh-session-eval'
```

## Try it once

In DeepSeek Harness:

```text
/eval
```

```text
Session eval — a1b2c3d4… (dsh-session-eval v0.2.2)
Overall: A
  Reliability   A    2/87 tool results errored (2.3%)
  Re-ask        A    1 re-ask signal(s) over 23 turns (0.4/10 turns)
  Tool load     B    3.8 tool calls per turn
Notes:
  • Wall time 41.2 min over 23 turns.
```

## The measurement layer of the session toolchain

| Plugin | Layer | Answers |
|---|---|---|
| [`dsh-session-export`](https://www.npmjs.com/package/dsh-session-export) | Evidence | "What exactly happened in this session?" |
| [`dsh-session-recall`](https://www.npmjs.com/package/dsh-session-recall) | Memory | "What did I do before, and where is it?" |
| **`dsh-session-eval`** | **Measurement** | **"Was that session good? Is the trend improving?"** |

All three read through the same trusted `ctx.sessionQuery` seam, so any persistence backend (JSONL or SQLite) works without touching raw artifacts.

## Contributing

- **Local dev**: `npm ci && npm run typecheck && npm test && npm run bundle` (Node 20 or 22).
- **Start in the source**: [`src/grade.ts`](src/grade.ts) (thresholds, grade cards), [`src/metrics.ts`](src/metrics.ts) (metric extraction), [`src/trend.ts`](src/trend.ts) (`/eval-history` trend logic). See [CONTRIBUTING.md](CONTRIBUTING.md) for the source map and first-PR suggestions.
- **Open gaps**: [#1](https://github.com/kittimzhe/dsh-session-eval/issues/1) (configurable thresholds), [#2](https://github.com/kittimzhe/dsh-session-eval/issues/2) (`/eval-history --since`), [#3](https://github.com/kittimzhe/dsh-session-eval/issues/3) (`/eval-history --out`) — or browse [issues labeled `good first issue`](https://github.com/kittimzhe/dsh-session-eval/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).
- **Rules**: behavior changes need tests; doc changes must update `README.md` and `README.zh.md` in sync; version releases belong to the maintainer. Details: [CONTRIBUTING.md](CONTRIBUTING.md).

## How it differs from benchmark-style evaluation

| | `dsh-eval` (benchmark) | `dsh-session-eval` (this) |
|---|---|---|
| Evaluates | Runs you launch ahead of time | Sessions that already happened |
| Setup | Author benchmark YAML + cases | None — read existing logs |
| Judge | Metric folding over trials | Fixed thresholds, deterministic |
| Best at | Pre-deploy benchmarks | Regression tracking over real work |

Both are useful; they don't compete. Benchmarks test what you *predicted*; retrospective evaluation watches what *actually happened*.

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

`/eval-history` finds the sessions for you via the same `sessionQuery` seam `/archive` uses (scoped to the current workspace's `cwd`), grades each, and diffs the first against the last. `/eval-diff` remains the tool when you already know the two ids that matter.

Typical use: grade the ten sessions before and after a plugin or prompt change; a persistent `Reliability` regression is an early warning that the change hurt real work, not just benchmarks.

## Dimensions & thresholds

All grades derive from three deterministic metrics. `n/a` when the session lacks the relevant activity.

| Dimension | Metric | A | B | C | D | E |
|---|---|---|---|---|---|---|
| Reliability | tool error rate | ≤5% | ≤10% | ≤20% | ≤35% | >35% |
| Re-ask | corrections per 10 turns¹ | 0 | <1 | <2 | <4 | ≥4 |
| Tool load | tool calls per turn | 0.5–8 | 0.1–0.5 or just above 8 | <0.1 or 8–20 | >20 | — |

¹ A *correction signal* is each extra user message inside a consecutive-user run — the human re-asking before any assistant reply, a behavioral proxy for "the agent didn't get it right the first time."

`Overall` is the **worst** graded dimension — conservative by design. Thresholds are constants in [`src/grade.ts`](src/grade.ts); making them configurable is on the roadmap (see issues).

Diff verdicts include a noise band (±2pp error rate, ±0.5 re-ask, ±1 tool load) so trivial jitter doesn't cry regression.

## Determinism guarantee

Same session logs in → same grade card out, every time, forever. There is no model in the loop, no sampling, no clock dependence in the metrics (wall time is reported, never graded). This is what makes `/eval-diff` trustworthy as a regression signal.

## Development

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run bundle      # tsdown → lib/
```

## License

[MIT](LICENSE)

## Community

- [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md) · [Code of Conduct](CODE_OF_CONDUCT.md)
