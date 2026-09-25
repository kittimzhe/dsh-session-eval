# dsh-session-eval

[![npm](https://img.shields.io/npm/v/dsh-session-eval)](https://www.npmjs.com/package/dsh-session-eval)
[![tests](https://github.com/kittimzhe/dsh-session-eval/actions/workflows/test.yml/badge.svg)](https://github.com/kittimzhe/dsh-session-eval/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**DeepSeek Harness 会话的回溯式评测**：对已经发生的会话做确定性等级评定，跨会话回归对比，回答"换了插件 / prompt / 模型之后，我的 agent 是变好了还是变差了？"

不需要编写基准测试集，没有 LLM 裁判，不需要跑新任务。所有等级 = 持久化会话日志上的固定公开阈值——完全可复现。

English | [中文](README.zh.md)

## 会话工具链的评测层

| 插件 | 层 | 回答的问题 |
|---|---|---|
| `dsh-session-export` | 证据层 | "这个会话到底发生了什么？" |
| `dsh-session-recall` | 记忆层 | "我以前做过什么，在哪？" |
| **`dsh-session-eval`** | **评测层** | **"刚才的会话好不好？趋势在变好吗？"** |

三者都通过同一个可信的 `ctx.sessionQuery` 缝读取，JSONL / SQLite 等任何持久化后端均可使用。

## 与基准式评测（dsh-eval）的区别

- `dsh-eval`：**前瞻**——预先写好基准 YAML，跑无头评测，评的是"你预测到的场景"
- 本插件：**回溯**——直接读存量日志，评的是"真实发生的工作"，零准备、零额外 token

两者互补而非竞争。

## 快速开始

```bash
npm install -g dsh-session-eval
```

```text
/eval                 # 当前会话等级卡
/eval --id <会话ID>    # 指定会话
/eval-diff <前> <后>   # 回归对比（换插件/prompt 前后各评一次）
/eval-history         # 本工作区最近 5 个会话的成绩单 + 首末趋势
/eval-history 12      # 最近 12 个
```

`/eval-history` 通过与 `/archive` 相同的 `sessionQuery` 接缝自动找到会话（按当前工作区 `cwd` 过滤），逐个评级，并把首尾两个会话做趋势对比——不用再手动挑 id。

## 维度与阈值（确定性，无裁判）

| 维度 | 指标 | A | B | C | D | E |
|---|---|---|---|---|---|---|
| Reliability | 工具错误率 | ≤5% | ≤10% | ≤20% | ≤35% | >35% |
| Re-ask | 每 10 轮纠正信号¹ | 0 | <1 | <2 | <4 | ≥4 |
| Tool load | 每轮工具调用 | 0.5–8 | 0.1–0.5 | <0.1 或 8–20 | >20 | — |

¹ 纠正信号 = 连续用户消息中多出的那条（agent 还没回复用户就重问）——"第一次没做对"的行为学代理指标。

总评 = 最差维度（保守设计）。Diff 判定带噪声带（错误率 ±2pp 等），微小抖动不会误报回归。

## 确定性保证

同样的日志进 → 同样的等级出。没有模型在环、没有采样、指标不含时钟依赖（wall time 只报告不评级）。这是 `/eval-diff` 能作为回归信号被信任的原因。

## 开发

```bash
npm install && npm run typecheck && npm test   # 24 个测试
npm run bundle
```

## 许可

[MIT](LICENSE)
