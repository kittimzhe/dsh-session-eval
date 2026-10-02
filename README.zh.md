# dsh-session-eval

[English](README.md) | 中文

[![npm](https://img.shields.io/npm/v/dsh-session-eval)](https://www.npmjs.com/package/dsh-session-eval)
[![tests](https://github.com/kittimzhe/dsh-session-eval/actions/workflows/test.yml/badge.svg)](https://github.com/kittimzhe/dsh-session-eval/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**DeepSeek Harness 会话的回溯式评测**：对已经发生的会话做确定性等级评定，跨会话回归对比，回答"换了插件 / prompt / 模型之后，我的 agent 是变好了还是变差了？"

不需要编写基准测试集，没有 LLM 裁判，不需要跑新任务。所有等级 = 持久化会话日志上的固定公开阈值——完全可复现。

## 安装

```bash
dsh plugin --profile web add dsh-session-eval
```

## 试一次

在 DeepSeek Harness 里：

```text
/eval
```

```text
Session eval — a1b2c3d4… (dsh-session-eval v0.2.1)
Overall: A
  Reliability   A    2/87 tool results errored (2.3%)
  Re-ask        A    1 re-ask signal(s) over 23 turns (0.4/10 turns)
  Tool load     B    3.8 tool calls per turn
Notes:
  • Wall time 41.2 min over 23 turns.
```

## 会话工具链的评测层

| 插件 | 层 | 回答的问题 |
|---|---|---|
| [`dsh-session-export`](https://www.npmjs.com/package/dsh-session-export) | 证据层 | "这个会话到底发生了什么？" |
| [`dsh-session-recall`](https://www.npmjs.com/package/dsh-session-recall) | 记忆层 | "我以前做过什么，在哪？" |
| **`dsh-session-eval`** | **评测层** | **"刚才的会话好不好？趋势在变好吗？"** |

三者都通过同一个可信的 `ctx.sessionQuery` 缝读取，JSONL / SQLite 等任何持久化后端均可使用。

## 贡献

- **本地开发**：`npm ci && npm run typecheck && npm test && npm run bundle`（Node 20 或 22）。
- **源码入口**：[`src/grade.ts`](src/grade.ts)（阈值与等级卡）、[`src/metrics.ts`](src/metrics.ts)（指标提取）、[`src/trend.ts`](src/trend.ts)（`/eval-history` 趋势逻辑）。源码地图与第一次 PR 建议见 [CONTRIBUTING.md](CONTRIBUTING.md)。
- **当前缺口**：阈值可配置、`/eval-history` 过滤条件扩展、趋势导出——见 [`good first issue` 标签的 issue](https://github.com/kittimzhe/dsh-session-eval/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)。
- **规矩**：行为变更必须带测试；文档必须 `README.md` 与 `README.zh.md` 同步改；版本发布由维护者执行。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 与基准式评测（dsh-eval）的区别

| | `dsh-eval`（基准） | `dsh-session-eval`（本插件） |
|---|---|---|
| 评什么 | 预先发起的运行 | 已经发生的会话 |
| 准备 | 编写基准 YAML + 用例 | 零——直接读存量日志 |
| 裁判 | 跨 trial 的指标折叠 | 固定阈值，确定性 |
| 擅长 | 上线前基准 | 真实工作的回归追踪 |

两者互补而非竞争：基准测你*预测到*的场景，回溯评测看*实际发生*的工作。

## 命令

| 命令 | 效果 |
|---|---|
| `/eval` | 当前会话等级卡 |
| `/eval --id <会话ID>` | 指定会话 |
| `/eval --json` | 机器可读指标 + 等级卡 |
| `/eval-diff <前ID> <后ID>` | 回归对比（带噪声带） |
| `/eval-diff … --json` | 机器可读趋势报告 |
| `/eval-history [N]` | 本工作区最近 N 个会话成绩单 + 首末趋势 |
| `/eval-history … --json` | 机器可读历史报告 |

使用 `/eval-history --out report.md` 将终端卡片保存为 Markdown，添加 `--json` 则保存 JSON。相对路径基于当前会话工作目录（缺失时使用进程工作目录）。父目录必须已存在；写入失败会返回错误，不会创建目录。已存在的输出文件会被覆盖。

`/eval-history` 通过与 `/archive` 相同的 `sessionQuery` 接缝自动找到会话（按当前工作区 `cwd` 过滤），逐个评级，并把首尾两个会话做趋势对比——不用再手动挑 id。已经知道两个关键 id 时用 `/eval-diff`。

典型用法：换插件或 prompt 前后各评十个会话；`Reliability` 持续回归 = 改动伤害了真实工作的早期预警。

## 维度与阈值（确定性，无裁判）

| 维度 | 指标 | A | B | C | D | E |
|---|---|---|---|---|---|---|
| Reliability | 工具错误率 | ≤5% | ≤10% | ≤20% | ≤35% | >35% |
| Re-ask | 每 10 轮纠正信号¹ | 0 | <1 | <2 | <4 | ≥4 |
| Tool load | 每轮工具调用 | 0.5–8 | 0.1–0.5 | <0.1 或 8–20 | >20 | — |

¹ 纠正信号 = 连续用户消息中多出的那条（agent 还没回复用户就重问）——"第一次没做对"的行为学代理指标。

总评 = 最差维度（保守设计）。阈值是 [`src/grade.ts`](src/grade.ts) 中的常量；可配置化在路线图上（见 issue）。

Diff 判定带噪声带（错误率 ±2pp、Re-ask ±0.5、工具负载 ±1），微小抖动不会误报回归。

## 确定性保证

同样的日志进 → 同样的等级出。没有模型在环、没有采样、指标不含时钟依赖（wall time 只报告不评级）。这是 `/eval-diff` 能作为回归信号被信任的原因。

## 许可

[MIT](LICENSE)
