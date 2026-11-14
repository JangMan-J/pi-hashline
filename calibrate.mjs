#!/usr/bin/env node
/**
 * Fast, deterministic edit-tool calibrator for `pi-hashline`.
 *
 * Races Stock `edit(oldText, newText)` vs `hashline_edit` (`PI_HASHLINE=force`) on two orthogonal,
 * bash-free file-refactoring micro-tasks (`--tools read,edit` — 0 test-runner turns, 2 LLM turns max:
 * Turn 1 `read`, Turn 2 `edit`, verified externally in <20 ms by Node assertions!).
 *
 * Writes empirical per-model routing decisions (`"hashline"` vs `"replace"`) directly into
 * `~/.pi/agent/hashline.json` (`calibrated` map), respecting `config.minSpeedup` (default 1.15x)
 * and never overwriting user `"pinned": true` rules.
 *
 * Usage:
 *   node calibrate.mjs                                      # default roster across configured families
 *   node calibrate.mjs anthropic/claude-opus-5-5 xai/grok-4.7
 *   node calibrate.mjs --thinking medium --min-speedup 1.15 --dry-run
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXT_PATH = path.resolve(import.meta.dirname, "index.ts");
const CONFIG_PATH = process.env.PI_HASHLINE_CONFIG?.trim()
	? path.resolve(process.env.PI_HASHLINE_CONFIG.trim())
	: path.join(os.homedir(), ".pi/agent/hashline.json");

const DEFAULT_ROSTER = [
	"anthropic/claude-opus-5-5",
	"antigravity/gemini-4-carbon",
	"antigravity/gemini-4-argon",
	"openai-codex/gpt-6-astra",
	"kimi-coding/k3.1-pro-highspeed",
	"xai/grok-4.7",
];

function parseCli(argv) {
	let thinking = "high";
	let minSpeedup = undefined;
	let dryRun = false;
	let concurrency = 3;
	const models = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--thinking" && argv[i + 1]) thinking = argv[++i];
		else if (a === "--min-speedup" && argv[i + 1]) minSpeedup = Number(argv[++i]);
		else if (a === "--concurrency" && argv[i + 1]) concurrency = Math.max(1, Number(argv[++i]));
		else if (a === "--dry-run") dryRun = true;
		else if (!a.startsWith("-")) models.push(a);
	}
	return { thinking, minSpeedup, dryRun, concurrency, models: models.length > 0 ? models : DEFAULT_ROSTER };
}

// ---------------------------------------------------------------------------
// Task 1: 420-line multi-query SQL/TS repository (4 non-adjacent hunks, 7 untouched twins)
// ---------------------------------------------------------------------------
function buildTask1Source() {
	const lines = [
		"export interface QueryWindow {",
		"  orgId: string;",
		"  fromTs: string;",
		"  toTs: string;",
		"  limit?: number;",
		"}",
		"",
		"export interface BuiltQuery {",
		"  id: string;",
		"  sql: string;",
		"  binds: unknown[];",
		"}",
		"",
	];
	const specs = [
		["activeUsers", "users", "active = true"],
		["paidOrders", "orders", "settled = true"],
		["openTickets", "tickets", "closed_at IS NULL"],
		["webhookErrors", "webhook_deliveries", "status_code >= 500"],
		["apiKeys", "api_keys", "revoked = false"],
		["auditEvents", "audit_log", "severity >= 2"],
		["seatGrants", "seat_assignments", "billable = true"],
		["exportJobs", "exports", "state = 'ready'"],
		["cronRuns", "cron_executions", "exit_code = 0"],
		["tokenLedger", "token_usage", "cached = false"],
	];
	for (let i = 0; i < specs.length; i++) {
		const [id, table, cond] = specs[i];
		lines.push(`/** Query builder for ${id}. */`);
		lines.push(`export function query_${id}(w: QueryWindow): BuiltQuery {`);
		lines.push(`  const maxRows = w.limit ?? ${100 + i * 20};`);
		lines.push(`  const sql = \``);
		lines.push(`    SELECT`);
		lines.push(`      r.id,`);
		lines.push(`      r.org_id,`);
		lines.push(`      r.created_at,`);
		lines.push(`      r.updated_at,`);
		lines.push(`      COUNT(*) OVER () AS total_count`);
		lines.push(`    FROM core.${table} AS r`);
		lines.push(`    INNER JOIN core.organizations AS o`);
		lines.push(`      ON o.id = r.org_id`);
		lines.push(`    WHERE r.org_id = $1`);
		lines.push(`      AND ${cond}`);
		lines.push(`      AND r.created_at >= $2`);
		lines.push(`      AND r.created_at < $3`);
		lines.push(`    ORDER BY r.created_at DESC, r.id ASC`);
		lines.push(`    LIMIT $4`);
		lines.push(`  \`.trim();`);
		lines.push(`  return {`);
		lines.push(`    id: "${id}",`);
		lines.push(`    sql,`);
		lines.push(`    binds: [w.orgId, w.fromTs, w.toTs, maxRows],`);
		lines.push(`  };`);
		lines.push(`}`);
		lines.push(``);
		lines.push(`export function describe_${id}(w: QueryWindow): string {`);
		lines.push(`  const q = query_${id}(w);`);
		lines.push(`  return \`\${q.id}:\${q.binds.length}:\${q.sql.splitlines ? 0 : q.sql.length}\`;`);
		lines.push(`}`);
		lines.push(``);
	}
	return lines.join("\n") + "\n";
}

const TASK1 = {
	id: "sql-4hunk",
	filename: "queries.ts",
	source: buildTask1Source,
	prompt:
		"Read `queries.ts` and make ONLY these targeted edits (do NOT use `write` and do NOT touch the other 7 query builders):\n" +
		"1. Add `includeArchived?: boolean;` to `QueryWindow`.\n" +
		"2. In ONLY `query_activeUsers`, `query_webhookErrors`, and `query_tokenLedger`, add `AND ($5::boolean OR r.archived_at IS NULL)` right after `AND r.created_at < $3`, and append `Boolean(w.includeArchived)` as the 5th element of `binds`.\n" +
		"Stop immediately after the edit succeeds with a 1-word reply `done`.",
	verifyJs: `
import assert from "node:assert/strict";
import * as m from "./queries.ts";
const changed = ["activeUsers", "webhookErrors", "tokenLedger"];
const untouched = ["paidOrders", "openTickets", "apiKeys", "auditEvents", "seatGrants", "exportJobs", "cronRuns"];
for (const k of changed) {
  const a = m["query_" + k]({ orgId: "o1", fromTs: "t0", toTs: "t1" });
  assert.equal(a.binds.length, 5, k + " binds len");
  assert.equal(a.binds[4], false, k + " default false");
  assert.ok(a.sql.includes("AND ($5::boolean OR r.archived_at IS NULL)"), k + " sql clause");
  const b = m["query_" + k]({ orgId: "o1", fromTs: "t0", toTs: "t1", includeArchived: true });
  assert.equal(b.binds[4], true, k + " true");
}
for (const k of untouched) {
  const u = m["query_" + k]({ orgId: "o1", fromTs: "t0", toTs: "t1" });
  assert.equal(u.binds.length, 4, k + " untouched len");
  assert.ok(!u.sql.includes("archived_at"), k + " untouched sql");
}
console.log("PASS");
`,
};

// ---------------------------------------------------------------------------
// Task 2: 260-line nested rate-limiter & retry policy module (indentation + block delete + logic change)
// ---------------------------------------------------------------------------
function buildTask2Source() {
	const lines = [
		"export interface RetryInput {",
		"  attempt: number;",
		"  statusCode: number;",
		"  retryAfterHeader?: string;",
		"  idempotent: boolean;",
		"}",
		"",
		"export interface RetryVerdict {",
		"  retry: boolean;",
		"  delayMs: number;",
		"  reason: string;",
		"}",
		"",
		"/** Deprecated v0 constant table — remove during cleanup. */",
		"export function legacyBackoffTable(): number[] {",
		"  const out: number[] = [];",
		"  for (let i = 0; i < 8; i++) {",
		"    out.push(100 * Math.pow(2, i));",
		"  }",
		"  return out;",
		"}",
		"",
	];
	// Add realistic surrounding policy helpers so file is ~240 lines
	for (let b = 1; b <= 6; b++) {
		lines.push(`export function classifyBucket${b}(code: number, latencyMs: number): string {`);
		lines.push(`  if (code >= 500) {`);
		lines.push(`    if (latencyMs > ${b * 1000}) {`);
		lines.push(`      return "upstream-timeout-${b}";`);
		lines.push(`    }`);
		lines.push(`    return "upstream-5xx-${b}";`);
		lines.push(`  }`);
		lines.push(`  if (code === 429) {`);
		lines.push(`    return "throttled-${b}";`);
		lines.push(`  }`);
		lines.push(`  return "ok-${b}";`);
		lines.push(`}`);
		lines.push(``);
	}
	lines.push(
		"export function decideRetry(input: RetryInput): RetryVerdict {",
		"  if (input.attempt >= 4) {",
		'    return { retry: false, delayMs: 0, reason: "max-attempts" };',
		"  }",
		"  if (input.statusCode === 429) {",
		"    const parsed = Number(input.retryAfterHeader);",
		"    const wait = Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : 500;",
		'    return { retry: true, delayMs: wait, reason: "rate-limited" };',
		"  }",
		"  if (input.statusCode >= 500 && input.idempotent) {",
		"    const exp = Math.min(8000, 250 * Math.pow(2, input.attempt));",
		'    return { retry: true, delayMs: exp, reason: "server-error" };',
		"  }",
		'  return { retry: false, delayMs: 0, reason: "non-retryable" };',
		"}",
		"",
	);
	for (let b = 7; b <= 11; b++) {
		lines.push(`export function classifyBucket${b}(code: number, latencyMs: number): string {`);
		lines.push(`  if (code >= 500) {`);
		lines.push(`    return latencyMs > ${b * 500} ? "slow-5xx-${b}" : "fast-5xx-${b}";`);
		lines.push(`  }`);
		lines.push(`  return "nominal-${b}";`);
		lines.push(`}`);
		lines.push(``);
	}
	return lines.join("\n") + "\n";
}

const TASK2 = {
	id: "nested-policy",
	filename: "policy.ts",
	source: buildTask2Source,
	prompt:
		"Read `policy.ts` and apply ONLY these targeted edits (do NOT use `write` and keep `classifyBucket1..11` unchanged):\n" +
		"1. Delete `legacyBackoffTable` (and its doc comment).\n" +
		"2. In `decideRetry`: raise the attempt cap from `4` to `5`; on `statusCode === 429`, clamp `wait` to at most `30000` ms (`Math.min(30000, ...)`), and also retry `statusCode === 408` when `input.idempotent` is true with `delayMs: 300` and `reason: \"request-timeout\"`.\n" +
		"Stop immediately after the edit succeeds with a 1-word reply `done`.",
	verifyJs: `
import assert from "node:assert/strict";
import * as m from "./policy.ts";
assert.equal("legacyBackoffTable" in m, false, "legacyBackoffTable must be removed");
assert.equal(m.decideRetry({ attempt: 4, statusCode: 503, idempotent: true }).retry, true, "attempt 4 now retries");
assert.equal(m.decideRetry({ attempt: 5, statusCode: 503, idempotent: true }).retry, false, "attempt 5 capped");
assert.equal(m.decideRetry({ attempt: 1, statusCode: 429, retryAfterHeader: "99", idempotent: false }).delayMs, 30000, "429 clamped to 30000");
assert.deepEqual(m.decideRetry({ attempt: 0, statusCode: 408, idempotent: true }), { retry: true, delayMs: 300, reason: "request-timeout" });
assert.equal(m.decideRetry({ attempt: 0, statusCode: 408, idempotent: false }).retry, false);
assert.equal(m.classifyBucket1(502, 2000), "upstream-timeout-1");
assert.equal(m.classifyBucket11(200, 10), "nominal-11");
console.log("PASS");
`,
};

const TASKS = [TASK1, TASK2];

function runSingleTrial(model, thinking, task, arm) {
	return new Promise((resolve) => {
		const root = fs.mkdtempSync(path.join("/var/tmp", `hl-cal-${arm}-`));
		const agentDir = path.join(root, "agent");
		const ws = path.join(root, "ws");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(ws, { recursive: true });
		fs.symlinkSync(path.join(os.homedir(), ".pi/agent/auth.json"), path.join(agentDir, "auth.json"));
		fs.writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({ defaultProjectTrust: "always", quietStartup: "header" }),
		);
		fs.writeFileSync(path.join(ws, task.filename), task.source(), "utf8");
		fs.writeFileSync(path.join(ws, "verify.mjs"), task.verifyJs, "utf8");

		const env = {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			TMPDIR: root,
			PI_HASHLINE: arm === "hashline" ? "force" : "off",
		};
		for (const k of Object.keys(env)) {
			if (k.startsWith("JING_") || k.startsWith("ZELLIJ")) delete env[k];
		}

		// Restrict tools strictly to read + edit/hashline_edit (no bash, write, MCP, or skills — pure 2-turn read+edit race!).
		const extArgs = arm === "hashline" ? ["-e", EXT_PATH] : [];
		const args = [
			"--no-extensions",
			"--no-mcp",
			"--no-skills",
			...extArgs,
			"--exclude-tools",
			"bash,write,grep,find,ls,codemode",
			"--model",
			model,
			"--thinking",
			thinking,
			"--mode",
			"json",
			"-p",
			task.prompt,
		];

		const t0 = performance.now();
		const child = spawn("pi", args, { cwd: ws, env, stdio: ["ignore", "pipe", "pipe"] });
		const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("close", () => {
			clearTimeout(timer);
			const wallMs = Math.round(performance.now() - t0);
			let msgStartTs = 0;
			let editMs = 0;
			let editBytes = 0;
			let editErrors = 0;
			let editCalls = 0;
			let apiError = "";

			for (const line of out.split("\n")) {
				if (!line.startsWith("{")) continue;
				try {
					const ev = JSON.parse(line);
					if (ev.type === "message_start") {
						msgStartTs = Date.now(); // fallback if event lacks ts
					}
					if (ev.type === "message_end" && ev.message?.role === "assistant") {
						const m = ev.message;
						if (m.errorMessage) apiError = m.errorMessage;
						const calls = (m.content ?? []).filter(
							(b) => b.type === "toolCall" && (b.name === "edit" || b.name === "hashline_edit"),
						);
						if (calls.length > 0) {
							editCalls += calls.length;
							for (const c of calls) {
								editBytes += Buffer.byteLength(JSON.stringify(c.arguments ?? {}), "utf8");
							}
						}
					}
					if (ev.type === "message_end" && ev.message?.role === "toolResult") {
						if ((ev.message.toolName === "edit" || ev.message.toolName === "hashline_edit") && ev.message.isError) {
							editErrors++;
						}
					}
				} catch {}
			}

			// Parse exact message_start -> tool_execution_end timestamps from Pi JSON stream
			const events = [];
			for (const line of out.split("\n")) {
				if (!line.startsWith("{")) continue;
				try {
					events.push(JSON.parse(line));
				} catch {}
			}
			// Sum assistant turns that emitted an edit/hashline_edit call using message timestamps
			let prevAssistantEnd = null;
			for (const ev of events) {
				if (ev.type === "message_end" && ev.message?.role === "assistant") {
					const m = ev.message;
					const hasEdit = (m.content ?? []).some(
						(b) => b.type === "toolCall" && (b.name === "edit" || b.name === "hashline_edit"),
					);
					if (hasEdit && prevAssistantEnd && m.timestamp) {
						editMs += Math.max(1, m.timestamp - prevAssistantEnd);
					}
					if (m.timestamp) prevAssistantEnd = m.timestamp;
				}
			}
			if (editMs === 0) editMs = wallMs;

			const ver = spawn("node", ["verify.mjs"], { cwd: ws });
			let verOut = "";
			ver.stdout.on("data", (d) => (verOut += d));
			ver.stderr.on("data", (d) => (verOut += d));
			ver.on("close", (vCode) => {
				fs.rmSync(root, { recursive: true, force: true });
				resolve({
					task: task.id,
					arm,
					pass: vCode === 0 && verOut.includes("PASS"),
					wallMs,
					editMs,
					editBytes,
					editCalls,
					editErrors,
					apiError: apiError || err.trim().slice(-200),
				});
			});
		});
	});
}

async function calibrateModel(model, thinking, minSpeedup) {
	// Run Task 1 and Task 2 paired (both arms start at the exact same moment per task)
	const results = [];
	for (const task of TASKS) {
		const [rep, hl] = await Promise.all([
			runSingleTrial(model, thinking, task, "replace"),
			runSingleTrial(model, thinking, task, "hashline"),
		]);
		results.push({ task: task.id, replace: rep, hashline: hl });
	}

	const repPasses = results.filter((r) => r.replace.pass).length;
	const hlPasses = results.filter((r) => r.hashline.pass).length;
	const repEditMs = results.reduce((s, r) => s + r.replace.editMs, 0);
	const hlEditMs = results.reduce((s, r) => s + r.hashline.editMs, 0);
	const repBytes = results.reduce((s, r) => s + r.replace.editBytes, 0);
	const hlBytes = results.reduce((s, r) => s + r.hashline.editBytes, 0);
	const speedup = +(repEditMs / Math.max(1, hlEditMs)).toFixed(2);
	const bytesRatio = +(repBytes / Math.max(1, hlBytes)).toFixed(2);

	let use = "replace";
	let reason = "";
	if (hlPasses === 0 && repPasses === 0) {
		const errNote = results[0]?.replace?.apiError || results[0]?.hashline?.apiError || "both arms failed";
		return { model, skipped: true, error: errNote.slice(0, 160) };
	}
	if (hlPasses > repPasses) {
		use = "hashline";
		reason = `higher accuracy (${hlPasses}/${TASKS.length} vs ${repPasses}/${TASKS.length})`;
	} else if (hlPasses < repPasses) {
		use = "replace";
		reason = `replace passed ${repPasses}/${TASKS.length} vs hashline ${hlPasses}/${TASKS.length}`;
	} else if (speedup >= minSpeedup) {
		use = "hashline";
		reason = `${speedup}x edit speedup >= ${minSpeedup}x (${hlPasses}/${TASKS.length} pass, ${bytesRatio}x smaller payload)`;
	} else if (speedup >= 1.05 && bytesRatio >= 1.6 && results.every((r) => r.hashline.editErrors === 0)) {
		use = "hashline";
		reason = `${speedup}x edit speedup + ${bytesRatio}x smaller payload (${hlPasses}/${TASKS.length} pass, 0 errors)`;
	} else {
		use = "replace";
		reason = `speedup ${speedup}x < ${minSpeedup}x threshold (${repPasses}/${TASKS.length} pass)`;
	}

	return {
		model: model.toLowerCase(),
		skipped: false,
		entry: {
			use,
			speedup,
			bytesRatio,
			passReplace: `${repPasses}/${TASKS.length}`,
			passHashline: `${hlPasses}/${TASKS.length}`,
			replaceEditMs: repEditMs,
			hashlineEditMs: hlEditMs,
			replaceBytes: repBytes,
			hashlineBytes: hlBytes,
			thinking,
			reason,
			measuredAt: new Date().toISOString(),
		},
	};
}

const cli = parseCli(process.argv.slice(2));
let cfg;
try {
	cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
} catch {
	const jitiPath = path.join(os.homedir(), ".local/share/pi-fork/current/node_modules/jiti/lib/jiti.mjs");
	const { createJiti } = await import(new URL(`file://${jitiPath}`).href);
	const { DEFAULT_CONFIG } = await createJiti(import.meta.url).import(path.resolve(import.meta.dirname, "config.ts"));
	cfg = structuredClone(DEFAULT_CONFIG);
}
const threshold = cli.minSpeedup ?? cfg.minSpeedup ?? 1.15;
cfg.minSpeedup = threshold;
cfg.calibrated ??= {};

console.log(`Calibrating ${cli.models.length} model(s) at thinking=${cli.thinking}, minSpeedup=${threshold}x ...`);

const queue = [...cli.models];
const outcomes = [];
async function worker() {
	while (queue.length > 0) {
		const m = queue.shift();
		if (!m) break;
		const res = await calibrateModel(m, cli.thinking, threshold);
		outcomes.push(res);
		if (res.skipped) {
			console.log(`  [SKIP] ${m}: ${res.error}`);
		} else {
			const e = res.entry;
			console.log(
				`  [${e.use.toUpperCase().padEnd(8)}] ${res.model.padEnd(34)} speedup=${String(e.speedup + "x").padEnd(6)} editMs=${e.replaceEditMs}->${e.hashlineEditMs}  bytes=${e.replaceBytes}->${e.hashlineBytes} (${e.bytesRatio}x)  pass=${e.passReplace}->${e.passHashline}`,
			);
			cfg.calibrated[res.model] = e;
		}
	}
}

await Promise.all(Array.from({ length: Math.min(cli.concurrency, cli.models.length) }, () => worker()));

if (!cli.dryRun) {
	fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
	const tmp = `${CONFIG_PATH}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
	fs.renameSync(tmp, CONFIG_PATH);
	console.log(`\nWrote calibrated routing table to ${CONFIG_PATH}`);
}
