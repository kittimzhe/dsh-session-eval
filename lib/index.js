import { SessionId } from "@deepseek-ai/dsh-session";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
//#region src/metrics.ts
/** Count a correction signal for every extra user message inside a consecutive-user run. */
function countCorrections(events) {
	let corrections = 0;
	let runLength = 0;
	for (const event of events) if (event.kind === "user") {
		runLength += 1;
		if (runLength >= 2) corrections += 1;
	} else runLength = 0;
	return corrections;
}
/** Compute the deterministic metric set for one session. */
function computeMetrics(sessionId, events) {
	const userTurns = events.filter((e) => e.kind === "user").length;
	const assistantMessages = events.filter((e) => e.kind === "assistant").length;
	const toolEvents = events.filter((e) => e.kind === "tool_call");
	const toolResults = events.filter((e) => e.kind === "tool_result");
	const toolCalls = Math.max(toolEvents.length, toolResults.length);
	const toolErrors = toolResults.filter((e) => e.isError === true).length;
	const corrections = countCorrections(events);
	const times = events.map((e) => e.time).filter((t) => Number.isFinite(t));
	const firstTime = times.length > 0 ? Math.min(...times) : null;
	const lastTime = times.length > 0 ? Math.max(...times) : null;
	return {
		sessionId,
		events: events.length,
		userTurns,
		assistantMessages,
		toolCalls,
		toolErrors,
		toolErrorRate: toolCalls > 0 ? toolErrors / toolCalls : 0,
		corrections,
		correctionRate: userTurns > 0 ? corrections / userTurns * 10 : 0,
		toolLoad: userTurns > 0 ? toolCalls / userTurns : 0,
		wallMs: firstTime !== null && lastTime !== null ? lastTime - firstTime : 0,
		firstTime,
		lastTime
	};
}
/**
* Project raw session-log events into the evaluation vocabulary.
*
* Defensive by design: the adapter matches the `user/message`,
* `assistant/message`, `tool/call`, `tool/result` event-type vocabulary
* (plus role-based fallbacks) and never throws — unknown shapes are skipped.
*/
function adaptEvents(raw) {
	const out = [];
	for (let i = 0; i < raw.length; i += 1) {
		const event = raw[i];
		if (event == null || typeof event !== "object") continue;
		const seq = typeof event.seq === "number" ? event.seq : i;
		const time = typeof event.time === "number" ? event.time : 0;
		const message = event.message ?? event.payload;
		const kind = classify(String(event.type ?? message?.type ?? ""), message);
		if (kind === null) continue;
		const isError = readBool(message, "isError") ?? readBool(message, "is_error") ?? readBool(event, "isError");
		const tool = typeof message?.tool === "string" ? message.tool : typeof message?.name === "string" ? message.name : void 0;
		out.push({
			seq,
			time,
			kind,
			tool: kind === "tool_call" || kind === "tool_result" ? tool : void 0,
			isError: kind === "tool_result" ? isError === true : void 0
		});
	}
	return out.sort((a, b) => a.seq - b.seq);
}
function classify(type, message) {
	const t = type.toLowerCase();
	if (t.includes("user/message") || t === "user") return "user";
	if (t.includes("assistant/message") || t === "assistant") return "assistant";
	if (t.includes("tool/call") || t.includes("tool_call")) return "tool_call";
	if (t.includes("tool/result") || t.includes("tool_result")) return "tool_result";
	const role = message?.role;
	if (role === "user") return "user";
	if (role === "assistant") return "assistant";
	return null;
}
function readBool(source, key) {
	const value = source?.[key];
	return typeof value === "boolean" ? value : void 0;
}
//#endregion
//#region src/grade.ts
/** The documented defaults; unchanged when no config is given. */
const DEFAULT_GRADE_BANDS = {
	reliability: [
		.05,
		.1,
		.2,
		.35
	],
	reask: [
		0,
		1,
		2,
		4
	],
	toolLoad: [
		.1,
		.5,
		8,
		20
	]
};
function gradeBy(rate, bands) {
	const grades = [
		"A",
		"B",
		"C",
		"D"
	];
	for (let i = 0; i < bands.length; i++) if (rate <= bands[i]) return grades[i];
	return "E";
}
const ORDER = [
	"A",
	"B",
	"C",
	"D",
	"E"
];
function worst(a, b) {
	return ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;
}
function pct(rate) {
	return `${(rate * 100).toFixed(1)}%`;
}
/**
* Grade one session deterministically. `bands` may override any subset of
* the dimensions; unspecified ones keep the documented defaults.
*/
function gradeSession(m, bands = {}) {
	const b = {
		...DEFAULT_GRADE_BANDS,
		...bands
	};
	const dimensions = [];
	const notes = [];
	if (m.toolCalls === 0) {
		dimensions.push({
			dimension: "Reliability",
			grade: "n/a",
			detail: "no tool calls"
		});
		notes.push("Reliability is n/a — the session made no tool calls.");
	} else {
		const grade = gradeBy(m.toolErrorRate, b.reliability);
		dimensions.push({
			dimension: "Reliability",
			grade,
			detail: `${m.toolErrors}/${m.toolCalls} tool results errored (${pct(m.toolErrorRate)})`
		});
	}
	if (m.userTurns === 0) dimensions.push({
		dimension: "Re-ask",
		grade: "n/a",
		detail: "no user turns"
	});
	else {
		const grade = gradeBy(m.correctionRate, b.reask);
		dimensions.push({
			dimension: "Re-ask",
			grade,
			detail: `${m.corrections} re-ask signal(s) over ${m.userTurns} turns (${m.correctionRate.toFixed(1)}/10 turns)`
		});
	}
	if (m.userTurns === 0 || m.toolCalls === 0) dimensions.push({
		dimension: "Tool load",
		grade: "n/a",
		detail: "no tool activity"
	});
	else {
		const [lowC, lowB, highC, highD] = b.toolLoad;
		let grade = "A";
		if (m.toolLoad < lowB) grade = m.toolLoad < lowC ? "C" : "B";
		if (m.toolLoad > highC) grade = worst(grade, m.toolLoad > highD ? "D" : "C");
		dimensions.push({
			dimension: "Tool load",
			grade,
			detail: `${m.toolLoad.toFixed(1)} tool calls per turn`
		});
	}
	if (m.events === 0) notes.push("Session is empty — all dimensions are provisional.");
	if (m.wallMs > 0 && m.userTurns > 0) notes.push(`Wall time ${(m.wallMs / 6e4).toFixed(1)} min over ${m.userTurns} turns.`);
	const graded = dimensions.filter((d) => d.grade !== "n/a");
	const overall = graded.length === 0 ? "n/a" : graded.reduce((acc, d) => worst(acc, d.grade), "A");
	return {
		sessionId: m.sessionId,
		dimensions,
		overall,
		notes
	};
}
//#endregion
//#region src/trend.ts
/** Minimum absolute change treated as signal (not noise). */
const ERROR_RATE_EPSILON = .02;
const REASK_EPSILON = .5;
const TOOL_LOAD_EPSILON = 1;
function verdict(before, after, eps, lowerIsBetter) {
	const delta = after - before;
	if (Math.abs(delta) <= eps) return "flat";
	return (lowerIsBetter ? delta < 0 : delta > 0) ? "improved" : "regressed";
}
/** Compare two sessions dimension by dimension. */
function compareSessions(before, after) {
	const deltas = [];
	if (before.toolCalls > 0 || after.toolCalls > 0) deltas.push({
		dimension: "Reliability",
		before: `${(before.toolErrorRate * 100).toFixed(1)}%`,
		after: `${(after.toolErrorRate * 100).toFixed(1)}%`,
		verdict: verdict(before.toolErrorRate, after.toolErrorRate, ERROR_RATE_EPSILON, true)
	});
	if (before.userTurns > 0 || after.userTurns > 0) deltas.push({
		dimension: "Re-ask",
		before: before.correctionRate.toFixed(1),
		after: after.correctionRate.toFixed(1),
		verdict: verdict(before.correctionRate, after.correctionRate, REASK_EPSILON, true)
	});
	if (before.toolCalls > 0 || after.toolCalls > 0) deltas.push({
		dimension: "Tool load",
		before: before.toolLoad.toFixed(1),
		after: after.toolLoad.toFixed(1),
		verdict: verdict(before.toolLoad, after.toolLoad, TOOL_LOAD_EPSILON, false)
	});
	const improved = deltas.filter((d) => d.verdict === "improved").length;
	const regressed = deltas.filter((d) => d.verdict === "regressed").length;
	return {
		before,
		after,
		deltas,
		overall: regressed > improved ? "regressed" : improved > regressed ? "improved" : "flat",
		summary: deltas.length === 0 ? "No comparable dimensions — both sessions lack tool or turn activity." : `${improved} improved, ${regressed} regressed, ${deltas.length - improved - regressed} flat.`
	};
}
//#endregion
//#region src/version.ts
/**
* Single source of truth for the plugin version string.
*
* @module dsh-session-eval/version
*/
const VERSION = "0.3.0";
//#endregion
//#region src/evalCommand.ts
const EVAL_USAGE = "Usage: /eval [--id <sessionId>] [--json]";
const EVAL_DIFF_USAGE = "Usage: /eval-diff <beforeSessionId> <afterSessionId> [--json]";
function id8(sessionId) {
	return sessionId.length > 8 ? `${sessionId.slice(0, 8)}…` : sessionId;
}
/** Parse /eval input; returns args or a usage-error string. */
function parseEvalArgs(rawInput) {
	const trimmed = rawInput.trim();
	if (trimmed.length === 0) return {};
	const tokens = trimmed.split(/\s+/);
	const args = {};
	let i = 0;
	while (i < tokens.length) {
		const token = tokens[i];
		if (token === void 0) break;
		if (token === "--id") {
			const value = tokens[i + 1];
			if (value === void 0 || value.startsWith("--")) return `--id requires a session id value.\n${EVAL_USAGE}`;
			if (args.sessionId !== void 0) return `--id may be given only once.\n${EVAL_USAGE}`;
			args.sessionId = value;
			i += 2;
			continue;
		}
		if (token === "--json") {
			if (args.json === true) return `--json may be given only once.\n${EVAL_USAGE}`;
			args.json = true;
			i += 1;
			continue;
		}
		return `Unknown argument: ${token}\n${EVAL_USAGE}`;
	}
	return args;
}
/** Parse /eval-diff input; returns args or a usage-error string. */
function parseEvalDiffArgs(rawInput) {
	const tokens = rawInput.trim().split(/\s+/).filter((t) => t.length > 0);
	let json = false;
	const positional = [];
	for (const token of tokens) {
		if (token === "--json") {
			if (json) return `--json may be given only once.\n${EVAL_DIFF_USAGE}`;
			json = true;
			continue;
		}
		if (token.startsWith("--")) return `Unknown argument: ${token}\n${EVAL_DIFF_USAGE}`;
		positional.push(token);
	}
	if (positional.length !== 2) return `Expected exactly two session ids (before, after).\n${EVAL_DIFF_USAGE}`;
	const [beforeId, afterId] = positional;
	if (beforeId === afterId) return `The two session ids must differ.\n${EVAL_DIFF_USAGE}`;
	return {
		beforeId,
		afterId,
		json
	};
}
/** Render a grade card as terminal text. */
function renderCard(card, generator) {
	const lines = [`Session eval — ${id8(card.sessionId)} (${generator})`, `Overall: ${card.overall}`];
	for (const dimension of card.dimensions) lines.push(`  ${dimension.dimension.padEnd(13)} ${String(dimension.grade).padEnd(3)} ${dimension.detail}`);
	if (card.notes.length > 0) {
		lines.push("Notes:");
		for (const note of card.notes) lines.push(`  • ${note}`);
	}
	return lines.join("\n");
}
/** Render a trend report as terminal text. */
function renderTrend(report, generator) {
	const lines = [`Session diff — ${id8(report.before.sessionId)} → ${id8(report.after.sessionId)} (${generator})`, `Overall: ${report.overall} — ${report.summary}`];
	for (const delta of report.deltas) lines.push(`  ${delta.dimension.padEnd(13)} ${delta.before} → ${delta.after}   ${delta.verdict}`);
	return lines.join("\n");
}
async function readEvents(ctx, seam, sessionIdRaw) {
	try {
		return (await seam.readSession(SessionId(sessionIdRaw))).events;
	} catch (error) {
		return `Could not read session ${id8(sessionIdRaw)}: ${error instanceof Error ? error.message : String(error)}`;
	}
}
/** Execute /eval against the session-query seam. */
async function executeEval(ctx, invocation, seam = ctx.sessionQuery, bands = {}) {
	const parsed = parseEvalArgs(invocation.rawInput);
	if (typeof parsed === "string") return {
		kind: "error",
		text: parsed
	};
	const sessionIdRaw = parsed.sessionId ?? String(invocation.agent.session.id);
	const events = await readEvents(ctx, seam, sessionIdRaw);
	if (typeof events === "string") return {
		kind: "error",
		text: events
	};
	const metrics = computeMetrics(sessionIdRaw, adaptEvents(events));
	const card = gradeSession(metrics, bands);
	if (parsed.json === true) return {
		kind: "success",
		text: JSON.stringify({
			generator: "dsh-session-eval v0.3.0",
			metrics,
			card
		}, null, 2)
	};
	return {
		kind: "success",
		text: renderCard(card, "dsh-session-eval v0.3.0")
	};
}
/** Execute /eval-diff against the session-query seam. */
async function executeEvalDiff(ctx, invocation, seam = ctx.sessionQuery) {
	const parsed = parseEvalDiffArgs(invocation.rawInput);
	if (typeof parsed === "string") return {
		kind: "error",
		text: parsed
	};
	const beforeEvents = await readEvents(ctx, seam, parsed.beforeId);
	if (typeof beforeEvents === "string") return {
		kind: "error",
		text: beforeEvents
	};
	const afterEvents = await readEvents(ctx, seam, parsed.afterId);
	if (typeof afterEvents === "string") return {
		kind: "error",
		text: afterEvents
	};
	const report = compareSessions(computeMetrics(parsed.beforeId, adaptEvents(beforeEvents)), computeMetrics(parsed.afterId, adaptEvents(afterEvents)));
	if (parsed.json === true) return {
		kind: "success",
		text: JSON.stringify({
			generator: "dsh-session-eval v0.3.0",
			report
		}, null, 2)
	};
	return {
		kind: "success",
		text: renderTrend(report, "dsh-session-eval v0.3.0")
	};
}
//#endregion
//#region src/historyCommand.ts
/**
* `/eval-history` — grade the last N sessions in this workspace and show the trend.
*
* Completes the regression-tracking story: `/eval-diff` compares two sessions
* you already know about; this command finds them for you (via
* `ctx.sessionQuery.listSessions()`, same seam as `/archive` in
* dsh-session-export) and answers "is the trend improving?" out of the box.
*
* @module dsh-session-eval/historyCommand
*/
const EVAL_HISTORY_USAGE = "Usage: /eval-history [N] [--json] [--out PATH] [--since 24h|7d|30d]  (N = last N sessions, 1-20, default 5; --since grades only sessions whose latest activity falls inside the window)";
/** Parse /eval-history input; returns args or a usage-error string. */
function parseEvalHistoryArgs(rawInput) {
	const tokens = rawInput.trim().split(/\s+/).filter((t) => t.length > 0);
	let count = 5;
	let json = false;
	let sawCount = false;
	let out;
	let since;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--since") {
			if (since !== void 0) return `--since may be given only once.\n${EVAL_HISTORY_USAGE}`;
			const value = tokens[++i];
			const match = /^(\d+)(h|d)$/.exec(value ?? "");
			if (!match) return `--since needs a window like 24h or 7d.\n${EVAL_HISTORY_USAGE}`;
			const amount = Number(match[1]);
			if (amount < 1 || amount > 365) return `--since window is out of range.\n${EVAL_HISTORY_USAGE}`;
			since = {
				label: value,
				ms: amount * (match[2] === "h" ? 36e5 : 864e5)
			};
			continue;
		}
		if (token === "--out") {
			if (out !== void 0) return `--out may be given only once.\n${EVAL_HISTORY_USAGE}`;
			const path = tokens[++i];
			if (!path || path.startsWith("--")) return `--out requires a path.\n${EVAL_HISTORY_USAGE}`;
			out = path;
			continue;
		}
		if (token === "--json") {
			if (json) return `--json may be given only once.\n${EVAL_HISTORY_USAGE}`;
			json = true;
			continue;
		}
		if (token.startsWith("--")) return `Unknown argument: ${token}\n${EVAL_HISTORY_USAGE}`;
		if (sawCount) return `Expected at most one count argument.\n${EVAL_HISTORY_USAGE}`;
		if (!/^\d+$/.test(token)) return `N must be a positive integer.\n${EVAL_HISTORY_USAGE}`;
		const value = Number(token);
		if (value < 1 || value > 20) return `N must be between 1 and 20.\n${EVAL_HISTORY_USAGE}`;
		count = value;
		sawCount = true;
	}
	return {
		count,
		json,
		...out !== void 0 ? { out } : {},
		...since !== void 0 ? { since } : {}
	};
}
function toMillis(createdAt) {
	if (typeof createdAt === "number" && Number.isFinite(createdAt)) return createdAt;
	if (typeof createdAt === "string") {
		const parsed = Date.parse(createdAt);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}
function stamp(ms) {
	if (ms === null) return "?";
	return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}
/** Render a history report as terminal text. */
function renderHistory(report) {
	const lines = [];
	if (report.entries.length === 0) {
		if (report.sinceLabel !== void 0) return `No sessions with activity in the last ${report.sinceLabel} in this workspace; nothing to grade.`;
		return "No sessions found in this workspace; nothing to grade.";
	}
	lines.push(`Session history — last ${report.entries.length} in this workspace`);
	for (const entry of report.entries) {
		const m = entry.metrics;
		lines.push(`  ${stamp(entry.createdAt)}  ${id8(entry.sessionId)}  ${String(entry.card.overall).padEnd(2)}  ${m.userTurns} turns, ${m.toolCalls} tools`);
	}
	const trend = report.trend;
	if (trend !== null) lines.push(`Trend (first → last): ${trend.overall} — ${trend.summary}`);
	return lines.join("\n");
}
/** Execute /eval-history against the session-query seam. */
async function executeEvalHistory(ctx, invocation, seam = ctx.sessionQuery, bands = {}) {
	const parsed = parseEvalHistoryArgs(invocation.rawInput);
	if (typeof parsed === "string") return {
		kind: "error",
		text: parsed
	};
	const ownCwd = invocation.agent.session.header?.cwd;
	let records;
	try {
		records = await seam.listSessions();
	} catch (error) {
		return {
			kind: "error",
			text: `Could not list sessions: ${error instanceof Error ? error.message : String(error)}`
		};
	}
	const headers = records.map((record) => record.header).filter((header) => header != null).filter((header) => ownCwd === void 0 || header.cwd === ownCwd).map((header) => ({
		id: String(header.id),
		createdAt: toMillis(header.createdAt)
	})).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
	const activityCache = /* @__PURE__ */ new Map();
	let recent = headers.slice(-parsed.count);
	if (parsed.since !== void 0) {
		const cutoff = Date.now() - parsed.since.ms;
		const chosen = [];
		for (let i = headers.length - 1; i >= 0 && chosen.length < parsed.count; i--) {
			const header = headers[i];
			let log;
			try {
				log = await seam.readSession(SessionId(header.id));
			} catch (error) {
				return {
					kind: "error",
					text: `Could not read session ${id8(header.id)}: ${error instanceof Error ? error.message : String(error)}`
				};
			}
			activityCache.set(header.id, log.events);
			if (adaptEvents(log.events).reduce((max, event) => Math.max(max, event.time), Number.NEGATIVE_INFINITY) >= cutoff) chosen.unshift(header);
		}
		recent = chosen;
	}
	const entries = [];
	for (const header of recent) {
		const cached = activityCache.get(header.id);
		let events;
		if (cached !== void 0) events = cached;
		else try {
			events = (await seam.readSession(SessionId(header.id))).events;
		} catch (error) {
			return {
				kind: "error",
				text: `Could not read session ${id8(header.id)}: ${error instanceof Error ? error.message : String(error)}`
			};
		}
		const metrics = computeMetrics(header.id, adaptEvents(events));
		entries.push({
			sessionId: header.id,
			createdAt: header.createdAt,
			metrics,
			card: gradeSession(metrics, bands)
		});
	}
	const report = {
		entries,
		trend: entries.length >= 2 ? compareSessions(entries[0].metrics, entries[entries.length - 1].metrics) : null,
		...parsed.since !== void 0 ? { sinceLabel: parsed.since.label } : {}
	};
	const text = parsed.json ? JSON.stringify({
		generator: `dsh-session-eval v${VERSION}`,
		report
	}, null, 2) : renderHistory(report);
	if (parsed.out !== void 0) {
		const path = resolve(typeof ownCwd === "string" ? ownCwd : process.cwd(), parsed.out);
		try {
			const output = parsed.json ? text : `\`\`\`text\n${text}\n\`\`\``;
			await writeFile(path, `${output}\n`, "utf8");
		} catch (error) {
			return {
				kind: "error",
				text: `Could not write history report to ${path}: ${error instanceof Error ? error.message : String(error)}`
			};
		}
	}
	return {
		kind: "success",
		text
	};
}
//#endregion
//#region src/config.ts
/**
* Plugin config parsing for dsh-session-eval.
*
* The config block lives under the plugin's node in the host config tree, so
* it is naturally per-profile: each profile can grade against its own bands.
*
* Shape (#1):
*
* ```yaml
* session-eval:
*   gradeBands:
*     reliability: [4, 8, 15, 30]   # tool error-rate percent, A–D upper bounds
*     reask: [0, 2, 4, 8]           # corrections per 10 user turns
*     toolLoad: [0.1, 0.5, 8, 20]   # tool calls per turn: [lowC, lowB, highC, highD]
* ```
*
* Unknown keys, wrong arity, non-numeric, negative or non-ascending values
* fail fast with a readable error — a silent fallback would grade sessions
* against bands nobody chose.
*
* @module dsh-session-eval/config
*/
const DIMENSIONS = [
	"reliability",
	"reask",
	"toolLoad"
];
const SHAPE = "4 ascending numbers: reliability = tool error-rate percent A–D upper bounds, reask = corrections per 10 user turns, toolLoad = [lowC, lowB, highC, highD] tool calls per turn";
function parseDimension(dimension, raw) {
	const where = `gradeBands.${dimension}`;
	if (raw.length !== 4) throw new Error(`${where} needs exactly ${SHAPE}`);
	const values = raw.map((entry) => {
		if (typeof entry !== "number" || !Number.isFinite(entry)) throw new Error(`${where} entries must each be a finite number (${SHAPE})`);
		return entry;
	});
	for (const value of values) if (value < 0) throw new Error(`${where} entries must not be negative (${SHAPE})`);
	for (let i = 1; i < values.length; i++) if (values[i] <= values[i - 1]) throw new Error(`${where} entries must be strictly ascending (${SHAPE})`);
	return values;
}
/**
* Parse the plugin config into grade bands. Returns the defaults unchanged
* when nothing is configured; throws a readable Error on any invalid input.
*/
function parseGradeBands(config) {
	if (config === void 0 || config === null) return DEFAULT_GRADE_BANDS;
	if (typeof config !== "object") throw new Error("session-eval config must be a mapping");
	const root = config;
	for (const key of Object.keys(root)) if (key !== "gradeBands") throw new Error(`Unknown session-eval config key "${key}" — only "gradeBands" is read`);
	const raw = root.gradeBands;
	if (raw === void 0) return DEFAULT_GRADE_BANDS;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("session-eval gradeBands must be a mapping");
	const overrides = {};
	for (const key of Object.keys(raw)) if (!DIMENSIONS.includes(key)) throw new Error(`Unknown gradeBands dimension "${key}" — expected one of ${DIMENSIONS.join(", ")}`);
	for (const dimension of DIMENSIONS) {
		const entry = raw[dimension];
		if (entry !== void 0) overrides[dimension] = parseDimension(dimension, entry);
	}
	const quad = (dimension) => overrides[dimension];
	return {
		reliability: overrides.reliability !== void 0 ? overrides.reliability.map((v) => v / 100) : DEFAULT_GRADE_BANDS.reliability,
		reask: overrides.reask !== void 0 ? quad("reask") : DEFAULT_GRADE_BANDS.reask,
		toolLoad: overrides.toolLoad !== void 0 ? quad("toolLoad") : DEFAULT_GRADE_BANDS.toolLoad
	};
}
//#endregion
//#region src/index.ts
const name = "session-eval";
const inject = ["commands", "sessionQuery"];
/**
* Plugin entry: mount the /eval, /eval-diff and /eval-history commands.
*
* `config` is the plugin's node in the host config tree (per-profile): its
* `gradeBands` block overrides the default grade thresholds — see config.ts.
* Invalid config fails fast here, at plugin load, rather than mid-grade.
*/
function apply(ctx, config) {
	const bands = parseGradeBands(config);
	ctx.effect(function* () {
		yield ctx.commands.register({
			name: "eval",
			description: "Print a deterministic grade card for this session (or another via --id): reliability, re-ask, tool load",
			handler: (invocation) => executeEval(ctx, invocation, void 0, bands)
		});
		yield ctx.commands.register({
			name: "eval-diff",
			description: "Compare two sessions (before, after) and report which dimensions improved or regressed",
			handler: (invocation) => executeEvalDiff(ctx, invocation)
		});
		yield ctx.commands.register({
			name: "eval-history",
			description: "Grade the last N sessions in this workspace (default 5) and show whether the trend is improving",
			handler: (invocation) => executeEvalHistory(ctx, invocation, void 0, bands)
		});
	}, "session-eval lifecycle");
}
//#endregion
export { EVAL_DIFF_USAGE, EVAL_HISTORY_USAGE, EVAL_USAGE, VERSION, adaptEvents, apply, compareSessions, computeMetrics, executeEval, executeEvalDiff, executeEvalHistory, gradeSession, id8, inject, name, parseEvalArgs, parseEvalDiffArgs, parseEvalHistoryArgs, renderCard, renderHistory, renderTrend };
