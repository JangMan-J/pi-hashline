#!/usr/bin/env node
/**
 * Fast, rate-limit-resilient in-process edit-tool calibrator for `pi-hashline`.
 *
 * Improvements over multi-process `pi -p` calibration:
 * 1. In-process `ModelRuntime.streamSimple()`: zero cold V8 / CLI startup overhead across trials.
 * 2. Pre-seeded 1-turn edit trials: embeds the file snapshot directly (raw lines for `built-in` `edit`,
 *    `[file#TAG]` + `LINE:TEXT` for `hashline_edit`), eliminating Turn 1 (`read`) and Turn 3 (`"done"`).
 *    Only the edit turn itself is generated (with 1 repair turn allowed if an edit call errors).
 * 3. Rate-limit-clean timing: wraps `fetch` so HTTP 429 / 5xx retry backoffs before the final `200 OK`
 *    attempt are excluded from `editMs`.
 * 4. Multi-repeat median (`--repeats 2` default = 8 calls total, fewer than 1 legacy 12-call run):
 *    alternates arm order across repeats (`replace||hashline`, then `hashline||replace`) and scores by
 *    median per-task `editMs` so single-sample network spikes never flip recommendations.
 *
 * Usage:
 *   node calibrate.mjs                                      # default roster across configured families
 *   node calibrate.mjs anthropic/claude-opus-5-5 xai/grok-4.7
 *   node calibrate.mjs --repeats 3 --thinking high --min-speedup 1.15 --dry-run
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_BENCH_REPEATS = 2;
export const DEFAULT_MAX_BENCH_CALLS = 24;
export const DEFAULT_MAX_BENCH_TOKENS = 120_000;
export const DEFAULT_BENCH_TIMEOUT_SEC = 300;

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

export function parseCli(argv) {
	let thinking = "high";
	let minSpeedup = undefined;
	let repeats = undefined;
	let stopOnOverrun = undefined;
	let maxCalls = undefined;
	let maxTokens = undefined;
	let timeoutSec = undefined;
	let dryRun = false;
	let reset = false;
	let progress = false;
	let concurrency = 3;
	const models = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--thinking" && argv[i + 1]) thinking = argv[++i];
		else if (a === "--min-speedup" && argv[i + 1]) minSpeedup = Number(argv[++i]);
		else if (a === "--repeats" && argv[i + 1]) repeats = Math.max(1, Math.round(Number(argv[++i])));
		else if (a === "--concurrency" && argv[i + 1]) concurrency = Math.max(1, Number(argv[++i]));
		else if (a === "--stop-on-overrun") stopOnOverrun = true;
		else if (a === "--no-stop-on-overrun") stopOnOverrun = false;
		else if (a === "--max-calls" && argv[i + 1]) maxCalls = Number(argv[++i]);
		else if (a === "--max-tokens" && argv[i + 1]) maxTokens = Number(argv[++i]);
		else if (a === "--timeout-sec" && argv[i + 1]) timeoutSec = Number(argv[++i]);
		else if (a === "--dry-run") dryRun = true;
		else if (a === "--reset" || a === "--unpin") reset = true;
		else if (a === "--progress") progress = true;
		else if (!a.startsWith("-")) models.push(a);
	}
	return {
		thinking,
		minSpeedup,
		repeats,
		stopOnOverrun,
		maxCalls,
		maxTokens,
		timeoutSec,
		dryRun,
		reset,
		progress,
		concurrency,
		models: models.length > 0 ? models : DEFAULT_ROSTER,
	};
}

/**
 * Resolve benchmark overrun policy. Off by default (`stopOnOverrun: false`):
 * benchmarks never stop or abort when exceeding estimated calls, tokens, or time
 * unless explicitly enabled in `hashline.json` or via CLI flags.
 */
export function resolveOverrunPolicy(cli = {}, cfg = {}) {
	const pos = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
	const stopOnOverrun = cli.stopOnOverrun !== undefined ? Boolean(cli.stopOnOverrun) : cfg.stopOnOverrun === true;
	const cliTimeout = pos(cli.timeoutSec);
	return {
		stopOnOverrun,
		maxCalls: stopOnOverrun ? (pos(cli.maxCalls) ?? pos(cfg.maxBenchCalls) ?? DEFAULT_MAX_BENCH_CALLS) : 0,
		maxTokens: stopOnOverrun ? (pos(cli.maxTokens) ?? pos(cfg.maxBenchTokens) ?? DEFAULT_MAX_BENCH_TOKENS) : 0,
		timeoutMs:
			cliTimeout !== undefined
				? cliTimeout * 1000
				: stopOnOverrun
					? (pos(cfg.benchTimeoutSec) ?? DEFAULT_BENCH_TIMEOUT_SEC) * 1000
					: 0,
	};
}

export function median(values) {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
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
	instructions:
		"Make ONLY these targeted edits to `queries.ts` (keep the other 7 query builders unchanged):\n" +
		"1. Add `includeArchived?: boolean;` to `QueryWindow`.\n" +
		"2. In ONLY `query_activeUsers`, `query_webhookErrors`, and `query_tokenLedger`, add `AND ($5::boolean OR r.archived_at IS NULL)` right after `AND r.created_at < $3`, and append `Boolean(w.includeArchived)` as the 5th element of `binds`.",
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
// Task 2: ~920-line deeply nested tab-indented telemetry router (block delete + 5 scattered hunks across 24 twins)
// ---------------------------------------------------------------------------
function buildTask2Source() {
	const lines = [
		"export interface RetryInput {",
		"	attempt: number;",
		"	statusCode: number;",
		"	retryAfterHeader?: string;",
		"	idempotent: boolean;",
		"}",
		"",
		"export interface RetryVerdict {",
		"	retry: boolean;",
		"	delayMs: number;",
		"	reason: string;",
		"}",
		"",
		"export interface RouteEnvelope {",
		"	stage: string;",
		"	region: string;",
		"	status: number;",
		"	latencyMs: number;",
		"	retryBudget: number;",
		"	dropped: boolean;",
		"}",
		"",
		"/** Deprecated v0 constant table — remove during cleanup. */",
		"export function legacyBackoffTable(): number[] {",
		"	const out: number[] = [];",
		"	for (let i = 0; i < 8; i++) {",
		"		out.push(100 * Math.pow(2, i));",
		"	}",
		"	return out;",
		"}",
		"",
	];
	const stages = [
		["ingestEdge", "us-east"],
		["authGateway", "us-east"],
		["sessionHydrator", "us-west"],
		["quotaEnforcer", "us-west"],
		["schemaValidator", "eu-central"],
		["payloadScrubber", "eu-central"],
		["tenantRouter", "ap-south"],
		["shardResolver", "ap-south"],
		["cachePrefetch", "us-east"],
		["featureFlags", "us-west"],
		["billingMeter", "eu-central"],
		["auditSink", "us-east"],
		["webhookFanout", "us-west"],
		["dlqDispatcher", "eu-central"],
		["rollupWriter", "ap-south"],
		["alertEvaluator", "us-east"],
		["traceSampler", "us-west"],
		["spanCompactor", "eu-central"],
		["indexFlusher", "ap-south"],
		["blobArchiver", "us-east"],
		["exportStreamer", "us-west"],
		["cursorCheckpointer", "eu-central"],
		["heartbeatMonitor", "ap-south"],
		["ledgerCommitter", "us-east"],
	];
	const pushStage = (idx) => {
		const [name, region] = stages[idx];
		const b = idx + 1;
		lines.push(`/** Deeply nested stage policy for ${name} (${region}). */`);
		lines.push(`export function evaluate_${name}(status: number, latencyMs: number, retryBudget: number): RouteEnvelope {`);
		lines.push(`	if (status >= 500) {`);
		lines.push(`		if (latencyMs > ${b * 400}) {`);
		lines.push(`			if (retryBudget <= 0) {`);
		lines.push(`				return {`);
		lines.push(`					stage: "${name}",`);
		lines.push(`					region: "${region}",`);
		lines.push(`					status,`);
		lines.push(`					latencyMs,`);
		lines.push(`					retryBudget: 0,`);
		lines.push(`					dropped: true,`);
		lines.push(`				};`);
		lines.push(`			}`);
		lines.push(`			return {`);
		lines.push(`				stage: "${name}",`);
		lines.push(`				region: "${region}",`);
		lines.push(`				status,`);
		lines.push(`				latencyMs,`);
		lines.push(`				retryBudget: retryBudget - 1,`);
		lines.push(`				dropped: false,`);
		lines.push(`			};`);
		lines.push(`		}`);
		lines.push(`	}`);
		lines.push(`	if (status === 429) {`);
		lines.push(`		return {`);
		lines.push(`			stage: "${name}",`);
		lines.push(`			region: "${region}",`);
		lines.push(`			status,`);
		lines.push(`			latencyMs,`);
		lines.push(`			retryBudget: Math.max(0, retryBudget - 1),`);
		lines.push(`			dropped: retryBudget <= 0,`);
		lines.push(`		};`);
		lines.push(`	}`);
		lines.push(`	return { stage: "${name}", region: "${region}", status, latencyMs, retryBudget, dropped: false };`);
		lines.push(`}`);
		lines.push(``);
	};
	for (let i = 0; i < 12; i++) pushStage(i);
	lines.push(
		"export function decideRetry(input: RetryInput): RetryVerdict {",
		"	if (input.attempt >= 4) {",
		'		return { retry: false, delayMs: 0, reason: "max-attempts" };',
		"	}",
		"	if (input.statusCode === 429) {",
		"		const parsed = Number(input.retryAfterHeader);",
		"		const wait = Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : 500;",
		'		return { retry: true, delayMs: wait, reason: "rate-limited" };',
		"	}",
		"	if (input.statusCode >= 500 && input.idempotent) {",
		"		const exp = Math.min(8000, 250 * Math.pow(2, input.attempt));",
		'		return { retry: true, delayMs: exp, reason: "server-error" };',
		"	}",
		'	return { retry: false, delayMs: 0, reason: "non-retryable" };',
		"}",
		"",
	);
	for (let i = 12; i < stages.length; i++) pushStage(i);
	return lines.join("\n") + "\n";
}

const TASK2 = {
	id: "deep-router-920",
	filename: "policy.ts",
	source: buildTask2Source,
	instructions:
		"Apply ONLY these targeted edits to `policy.ts` (keep the other 21 `evaluate_*` functions unchanged):\n" +
		"1. Delete `legacyBackoffTable` (and its doc comment).\n" +
		"2. In `decideRetry`: raise the attempt cap from `4` to `5`; on `statusCode === 429`, clamp `wait` to at most `30000` ms (`Math.min(30000, ...)`), and also retry `statusCode === 408` when `input.idempotent` is true with `delayMs: 300` and `reason: \"request-timeout\"`.\n" +
		"3. In ONLY `evaluate_quotaEnforcer`, `evaluate_billingMeter`, and `evaluate_ledgerCommitter`, treat `status === 503` as immediate drop when `retryBudget <= 1` (instead of `retryBudget <= 0`) inside the `latencyMs > ...` branch.",
	verifyJs: `
import assert from "node:assert/strict";
import * as m from "./policy.ts";
assert.equal("legacyBackoffTable" in m, false, "legacyBackoffTable must be removed");
assert.equal(m.decideRetry({ attempt: 4, statusCode: 503, idempotent: true }).retry, true, "attempt 4 now retries");
assert.equal(m.decideRetry({ attempt: 5, statusCode: 503, idempotent: true }).retry, false, "attempt 5 capped");
assert.equal(m.decideRetry({ attempt: 1, statusCode: 429, retryAfterHeader: "99", idempotent: false }).delayMs, 30000, "429 clamped to 30000");
assert.deepEqual(m.decideRetry({ attempt: 0, statusCode: 408, idempotent: true }), { retry: true, delayMs: 300, reason: "request-timeout" });
assert.equal(m.decideRetry({ attempt: 0, statusCode: 408, idempotent: false }).retry, false);
for (const [fn, thresh] of [["quotaEnforcer", 1600], ["billingMeter", 4400], ["ledgerCommitter", 9600]]) {
  assert.equal(m["evaluate_" + fn](503, thresh + 100, 1).dropped, true, fn + " 503 budget=1 must drop");
  assert.equal(m["evaluate_" + fn](502, thresh + 100, 1).dropped, false, fn + " 502 budget=1 must not drop");
  assert.equal(m["evaluate_" + fn](503, thresh + 100, 2).dropped, false, fn + " 503 budget=2 must not drop");
}
for (const untouched of ["ingestEdge", "authGateway", "tenantRouter", "dlqDispatcher", "heartbeatMonitor"]) {
  assert.equal(m["evaluate_" + untouched](503, 99999, 1).dropped, false, untouched + " must stay untouched");
}
console.log("PASS");
`,
};

export const TASKS = [TASK1, TASK2];

// ---------------------------------------------------------------------------
// Lazy in-process Pi SDK + native hashline engine loader (loaded once per process)
// ---------------------------------------------------------------------------
let cachedEnvPromise = null;

async function getBenchEnv() {
	if (!cachedEnvPromise) {
		cachedEnvPromise = (async () => {
			// Prefer a repo-local / peer-installed Pi; fall back to a local pi-fork install.
			let pca, createJiti, piEntry, tuiEntry, typeboxEntry;
			try {
				const localRequire = createRequire(import.meta.url);
				piEntry = localRequire.resolve("@earendil-works/pi-coding-agent");
				tuiEntry = localRequire.resolve("@earendil-works/pi-tui");
				typeboxEntry = localRequire.resolve("typebox");
				createJiti = (await import("jiti")).createJiti;
				pca = await import(pathToFileURL(piEntry).href);
			} catch {
				const piPkgRoot = path.join(os.homedir(), ".local/share/pi-fork/current/node_modules/@earendil-works/pi-coding-agent");
				const piReq = createRequire(path.join(piPkgRoot, "package.json"));
				pca = await import(pathToFileURL(path.join(piPkgRoot, "dist/index.js")).href);
				const jitiPath = path.join(os.homedir(), ".local/share/pi-fork/current/node_modules/jiti/lib/jiti.mjs");
				createJiti = (await import(pathToFileURL(jitiPath).href)).createJiti;
				piEntry = path.join(piPkgRoot, "dist/index.js");
				tuiEntry = path.join(piPkgRoot, "../pi-tui/dist/index.js");
				typeboxEntry = piReq.resolve("typebox");
			}
			const jiti = createJiti(import.meta.url, {
				fsCache: true,
				alias: {
					"@earendil-works/pi-coding-agent": piEntry,
					"@earendil-works/pi-tui": tuiEntry,
					typebox: typeboxEntry,
				},
			});
			const hlMod = await jiti.import(path.resolve(import.meta.dirname, "index.ts"));
			const cfgMod = await jiti.import(path.resolve(import.meta.dirname, "config.ts"));
			const modelRuntime = await pca.ModelRuntime.create();
			const natives = hlMod.loadOmpNatives();
			return {
				modelRuntime,
				createEditToolDefinition: pca.createEditToolDefinition,
				natives,
				hashlineSchema: hlMod.hashlineSchema,
				hashlineDescription: hlMod.COMPACT_DESCRIPTION,
				DEFAULT_CONFIG: cfgMod.DEFAULT_CONFIG,
			};
		})();
	}
	return cachedEnvPromise;
}

async function applyHashlineInDir(natives, store, ws, input) {
	const session = new natives.EditSession(store, {
		cwd: ws,
		mode: "hashline",
		allowFuzzy: true,
		fuzzyThreshold: 0.95,
		enforceSeenLines: true,
		maxColumns: 2000,
		blockAutoGenerated: true,
		planActive: false,
		urlSchemes: [],
		urlAliasSchemes: [],
		planWritableRoots: [],
		homeDir: os.homedir(),
		rawInput: false,
	});
	try {
		session.setArgsJson(JSON.stringify({ input: String(input ?? "") }));
		session.finish();
		const outcome = await session.apply({ lspFlush: false }, async (_err, req) => {
			if (req.op === "delete") {
				await fsp.unlink(req.path);
				return { written: "" };
			}
			if (req.op === "move" && req.moveTo) {
				await fsp.mkdir(path.dirname(req.moveTo), { recursive: true });
				await fsp.writeFile(req.moveTo, req.content ?? "", "utf8");
				await fsp.unlink(req.path);
				return { written: req.content ?? "" };
			}
			if (req.op === "create") {
				await fsp.mkdir(path.dirname(req.path), { recursive: true });
			}
			await fsp.writeFile(req.path, req.content ?? "", "utf8");
			return { written: req.content ?? "" };
		});
		return { text: outcome.text, isError: Boolean(outcome.isError) };
	} catch (e) {
		return { text: e instanceof Error ? e.message : String(e), isError: true };
	} finally {
		session.close();
	}
}

function resolveCatalogModel(modelRuntime, spec) {
	const slash = spec.indexOf("/");
	if (slash > 0) {
		const prov = spec.slice(0, slash);
		const id = spec.slice(slash + 1);
		const exact = modelRuntime.getModel(prov, id);
		if (exact) return exact;
	}
	const lower = spec.toLowerCase();
	return modelRuntime.getAllModels().find((m) => `${m.provider}/${m.id}`.toLowerCase() === lower || m.id.toLowerCase() === lower);
}

/**
 * Run a single pre-seeded 1-turn edit trial in-process (`0` subprocess spawns for the LLM!).
 * Uses a custom `fetch` wrapper so any 429 / 5xx retry backoff sleep prior to the final `200 OK`
 * response is stripped out of `editMs`. Allows up to 1 repair turn if a tool call errors or splits hunks.
 */
async function runSingleTrial(env, modelObj, thinking, task, arm, hooks, policy = { timeoutMs: 0 }) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `hl-cal-${arm}-`));
	const filePath = path.join(root, task.filename);
	const rawSource = task.source();
	fs.writeFileSync(filePath, rawSource, "utf8");
	fs.writeFileSync(path.join(root, "verify.mjs"), task.verifyJs, "utf8");

	const editDef = env.createEditToolDefinition(root);
	const store = arm === "hashline" ? new env.natives.EditStore() : null;
	let formattedSnapshot;
	let toolDef;
	let systemPrompt;

	if (arm === "hashline") {
		const tag = store.recordSnapshotFile(filePath);
		const header = env.natives.hashlineFormatHeader(task.filename, tag);
		const numbered = env.natives.hashlineFormatNumberedLines(rawSource, 1);
		store.recordSeenLinesFromBody(filePath, tag, numbered);
		formattedSnapshot = `${header}\n${numbered}`;
		toolDef = {
			name: "hashline_edit",
			description: env.hashlineDescription,
			parameters: env.hashlineSchema,
		};
		// Note: never use Pi's default "running inside pi" identity sentence (Antigravity rejects it with 429).
		systemPrompt =
			"You are a fast, precise code-refactoring assistant. The user message already includes the exact `read` snapshot of the target file with its `[PATH#TAG]` header and `LINE:TEXT` numbers. Call `hashline_edit` once to apply all requested changes in a single batched patch.";
	} else {
		formattedSnapshot = rawSource;
		toolDef = {
			name: editDef.name,
			description: editDef.description,
			parameters: editDef.parameters,
		};
		systemPrompt =
			"You are a fast, precise code-refactoring assistant. The user message already includes the exact contents of the target file. Call `edit` once (using `edits` array for multiple non-adjacent regions) to apply all requested changes.";
	}

	const messages = [
		{
			role: "user",
			content: `Current contents of \`${task.filename}\`:\n\`\`\`ts\n${formattedSnapshot}\`\`\`\n\n${task.instructions}`,
			timestamp: Date.now(),
		},
	];

	const controller = new AbortController();
	hooks?.registerAbort?.(controller);
	let timedOut = false;
	const timer =
		policy.timeoutMs > 0
			? setTimeout(() => {
					timedOut = true;
					controller.abort();
				}, policy.timeoutMs)
			: null;

	let editMs = 0;
	let wallMs = 0;
	let editBytes = 0;
	let editCalls = 0;
	let editErrors = 0;
	let apiCalls = 0;
	let totalTokens = 0;
	let rateLimitRetries = 0;
	let apiError = "";

	const verifyNow = () => {
		const res = spawnSync(process.execPath, ["verify.mjs"], { cwd: root, encoding: "utf8", timeout: 10_000 });
		return res.status === 0 && (res.stdout ?? "").includes("PASS");
	};

	try {
		// Max 2 turns: Turn 1 applies all edits in 1 call; Turn 2 is only used if Turn 1 had a tool error or partial edit.
		for (let turn = 0; turn < 2; turn++) {
			if (controller.signal.aborted) break;
			const turnStart = performance.now();
			let cleanAttemptStart = turnStart;
			let firstStreamAt = 0;
			const timedFetch = async (url, init) => {
				const attemptAt = performance.now();
				const res = await globalThis.fetch(url, init);
				if (res.ok) {
					cleanAttemptStart = attemptAt;
				} else if (res.status === 429 || res.status >= 500) {
					rateLimitRetries++;
				}
				return res;
			};

			const stream = env.modelRuntime.streamSimple(
				modelObj,
				{ systemPrompt, messages, tools: [toolDef] },
				{ reasoning: thinking, signal: controller.signal, fetch: timedFetch },
			);

			let finalMsg = null;
			for await (const ev of stream) {
				if (!firstStreamAt && ev.type === "start") {
					firstStreamAt = performance.now();
				}
				if (ev.type === "done") {
					finalMsg = ev.message;
				} else if (ev.type === "error") {
					finalMsg = ev.error;
					apiError = finalMsg?.errorMessage || "stream error";
				}
			}

			const turnEnd = performance.now();
			wallMs += Math.max(1, Math.round(turnEnd - turnStart));
			// Measure streaming generation duration (`done` - `start`) so cold TCP/OAuth/queue TTFT and 429 sleeps never skew editMs!
			const cleanTurnMs = Math.max(1, Math.round(turnEnd - (firstStreamAt || cleanAttemptStart)));

			if (!finalMsg) break;
			const u = finalMsg.usage;
			const tok =
				Number(u?.totalTokens) ||
				(Number(u?.input) || 0) +
					(Number(u?.output) || 0) +
					(Number(u?.cacheRead) || 0) +
					(Number(u?.cacheWrite) || 0);
			apiCalls += 1;
			totalTokens += tok;
			hooks?.onUsage?.(1, tok);

			if (finalMsg.errorMessage) {
				apiError = finalMsg.errorMessage;
				break;
			}

			const toolCalls = (finalMsg.content ?? []).filter(
				(b) => b.type === "toolCall" && (b.name === "edit" || b.name === "hashline_edit"),
			);
			if (toolCalls.length === 0) {
				editMs += cleanTurnMs;
				break;
			}

			editMs += cleanTurnMs;
			messages.push(finalMsg);

			let anyToolError = false;
			for (const tc of toolCalls) {
				editCalls++;
				editBytes += Buffer.byteLength(JSON.stringify(tc.arguments ?? {}), "utf8");
				let resultText = "";
				let isError = false;
				if (arm === "hashline") {
					const out = await applyHashlineInDir(env.natives, store, root, tc.arguments?.input);
					resultText = out.text;
					isError = out.isError;
				} else {
					try {
						const prepared = editDef.prepareArguments ? editDef.prepareArguments(tc.arguments) : tc.arguments;
						const out = await editDef.execute(tc.id, prepared, controller.signal, undefined, { cwd: root });
						resultText = out.content?.map((c) => c.text ?? "").join("\n") ?? "Edited";
						isError = Boolean(out.isError);
					} catch (e) {
						resultText = e instanceof Error ? e.message : String(e);
						isError = true;
					}
				}
				if (isError) {
					editErrors++;
					anyToolError = true;
				}
				messages.push({
					role: "toolResult",
					toolCallId: tc.id,
					toolName: tc.name,
					content: [{ type: "text", text: resultText }],
					isError,
					timestamp: Date.now(),
				});
			}

			// Stop immediately after Turn 1 if verification already passes!
			if (!anyToolError && verifyNow()) {
				break;
			}
		}

		const pass = !controller.signal.aborted && verifyNow();
		return {
			task: task.id,
			arm,
			pass,
			wallMs,
			editMs: editMs || wallMs,
			editBytes,
			editCalls,
			editErrors,
			rateLimitRetries,
			apiCalls,
			totalTokens,
			apiError: (timedOut ? `trial exceeded ${Math.round(policy.timeoutMs / 1000)}s timeout` : "") || apiError,
		};
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			task: task.id,
			arm,
			pass: false,
			wallMs: Math.max(1, wallMs),
			editMs: Math.max(1, editMs || wallMs),
			editBytes,
			editCalls,
			editErrors,
			rateLimitRetries,
			apiCalls,
			totalTokens,
			apiError: timedOut ? `trial exceeded ${Math.round(policy.timeoutMs / 1000)}s timeout` : msg,
		};
	} finally {
		if (timer) clearTimeout(timer);
		hooks?.unregisterAbort?.(controller);
		fs.rmSync(root, { recursive: true, force: true });
		hooks?.onStep?.(1);
	}
}

export async function calibrateModel(
	model,
	thinking,
	minSpeedup,
	onProgress,
	policy = { stopOnOverrun: false, maxCalls: 0, maxTokens: 0, timeoutMs: 0 },
	repeats = DEFAULT_BENCH_REPEATS,
) {
	const env = await getBenchEnv();
	const modelObj = resolveCatalogModel(env.modelRuntime, model);
	if (!modelObj) {
		return { model, skipped: true, error: `model not found in catalog: ${model}` };
	}

	const rounds = Math.max(1, Math.round(repeats));
	const totalSteps = TASKS.length * 2 * rounds;
	let doneSteps = 0;
	let apiCalls = 0;
	let totalTokens = 0;
	let overrunReason = "";
	const activeControllers = new Set();
	const abortActive = () => {
		for (const c of activeControllers) {
			try {
				c.abort();
			} catch {}
		}
	};
	const emit = () =>
		onProgress?.({
			model: model.toLowerCase(),
			done: Math.min(totalSteps, doneSteps),
			total: totalSteps,
			calls: apiCalls,
			tokens: totalTokens,
		});
	emit();

	const hooks = {
		registerAbort(c) {
			activeControllers.add(c);
			if (overrunReason) c.abort();
		},
		unregisterAbort(c) {
			activeControllers.delete(c);
		},
		onUsage(callsDelta, tokDelta) {
			apiCalls += callsDelta;
			totalTokens += tokDelta;
			emit();
			if (policy.stopOnOverrun && !overrunReason) {
				if (policy.maxCalls > 0 && apiCalls > policy.maxCalls) {
					overrunReason = `stopped on overrun: ${apiCalls} calls > maxBenchCalls (${policy.maxCalls})`;
					abortActive();
				} else if (policy.maxTokens > 0 && totalTokens > policy.maxTokens) {
					overrunReason = `stopped on overrun: ${totalTokens} tokens > maxBenchTokens (${policy.maxTokens})`;
					abortActive();
				}
			}
		},
		onStep(stepDelta) {
			doneSteps += stepDelta;
			emit();
		},
	};

	// Fan out across repeats in-process: 8-way single-burst fan-out on non-rate-limited providers (~15-30s total!),
	// stepping down to 4-way waves only on Google Direct / Vertex where per-minute quota buckets are tighter.
	const perTask = new Map(TASKS.map((t) => [t.id, { replace: [], hashline: [] }]));
	const allSpecs = [];
	for (let r = 0; r < rounds; r++) {
		for (const task of TASKS) {
			if (r % 2 === 0) {
				allSpecs.push({ task, arm: "replace" }, { task, arm: "hashline" });
			} else {
				allSpecs.push({ task, arm: "hashline" }, { task, arm: "replace" });
			}
		}
	}
	const isGoogleQuotaProvider = modelObj.provider === "google" || modelObj.provider === "google-vertex";
	const waveSize = isGoogleQuotaProvider ? 4 : Math.min(8, allSpecs.length);
	for (let offset = 0; offset < allSpecs.length; offset += waveSize) {
		if (overrunReason) break;
		const slice = allSpecs.slice(offset, offset + waveSize);
		const waveResults = await Promise.all(
			slice.map(({ task, arm }) => runSingleTrial(env, modelObj, thinking, task, arm, hooks, policy)),
		);
		for (let i = 0; i < slice.length; i++) {
			const { task, arm } = slice[i];
			perTask.get(task.id)[arm].push(waveResults[i]);
		}
	}

	if (overrunReason) {
		return { model, skipped: true, error: overrunReason };
	}

	const allRep = TASKS.flatMap((t) => perTask.get(t.id).replace);
	const allHl = TASKS.flatMap((t) => perTask.get(t.id).hashline);
	const totalTrialsPerArm = TASKS.length * rounds;
	const repPasses = allRep.filter((x) => x.pass).length;
	const hlPasses = allHl.filter((x) => x.pass).length;

	if (hlPasses === 0 && repPasses === 0) {
		const errNote =
			allRep.find((x) => x.apiError)?.apiError ||
			allHl.find((x) => x.apiError)?.apiError ||
			"both arms failed";
		return { model, skipped: true, error: errNote.slice(0, 160) };
	}

	// Score each task by median editMs across passing trials (falling back to all trials if an arm failed that task),
	// then sum the two task medians so one network/queue outlier never dominates.
	const taskMedianMs = (samples) => {
		const passing = samples.filter((s) => s.pass);
		const pool = passing.length > 0 ? passing : samples;
		return median(pool.map((s) => s.editMs));
	};
	const taskMedianBytes = (samples) => {
		const passing = samples.filter((s) => s.pass);
		const pool = passing.length > 0 ? passing : samples;
		return median(pool.map((s) => s.editBytes));
	};

	const repEditMs = TASKS.reduce((s, t) => s + taskMedianMs(perTask.get(t.id).replace), 0);
	const hlEditMs = TASKS.reduce((s, t) => s + taskMedianMs(perTask.get(t.id).hashline), 0);
	const repBytes = TASKS.reduce((s, t) => s + taskMedianBytes(perTask.get(t.id).replace), 0);
	const hlBytes = TASKS.reduce((s, t) => s + taskMedianBytes(perTask.get(t.id).hashline), 0);
	const speedup = +(repEditMs / Math.max(1, hlEditMs)).toFixed(2);
	const bytesRatio = +(repBytes / Math.max(1, hlBytes)).toFixed(2);
	const totalRetries = [...allRep, ...allHl].reduce((s, x) => s + (x.rateLimitRetries ?? 0), 0);

	let use = "replace";
	let reason = "";
	if (hlPasses > repPasses) {
		use = "hashline";
		reason = `higher accuracy (${hlPasses}/${totalTrialsPerArm} vs ${repPasses}/${totalTrialsPerArm})`;
	} else if (hlPasses < repPasses) {
		use = "replace";
		reason = `built-in passed ${repPasses}/${totalTrialsPerArm} vs hashline ${hlPasses}/${totalTrialsPerArm}`;
	} else if (speedup >= minSpeedup) {
		use = "hashline";
		reason = `${speedup}x median speedup >= ${minSpeedup}x (${hlPasses}/${totalTrialsPerArm} pass, ${bytesRatio}x smaller payload)`;
	} else if (speedup >= 1.05 && bytesRatio >= 1.6 && allHl.every((r) => r.editErrors === 0)) {
		use = "hashline";
		reason = `${speedup}x median speedup + ${bytesRatio}x smaller payload (${hlPasses}/${totalTrialsPerArm} pass, 0 errors)`;
	} else if (speedup >= 0.9 && bytesRatio >= 2.5 && allHl.every((r) => r.editErrors === 0)) {
		use = "hashline";
		reason = `${bytesRatio}x smaller edit payload at ${speedup}x speed parity (${hlPasses}/${totalTrialsPerArm} pass, 0 errors)`;
	} else {
		use = "replace";
		reason = `median speedup ${speedup}x < ${minSpeedup}x threshold (${repPasses}/${totalTrialsPerArm} pass, ${bytesRatio}x payload)`;
	}
	if (totalRetries > 0) {
		reason += ` [${totalRetries} 429/5xx backoff(s) excluded]`;
	}

	return {
		model: `${modelObj.provider}/${modelObj.id}`.toLowerCase(),
		skipped: false,
		entry: {
			use,
			speedup,
			bytesRatio,
			passReplace: `${repPasses}/${totalTrialsPerArm}`,
			passHashline: `${hlPasses}/${totalTrialsPerArm}`,
			replaceEditMs: repEditMs,
			hashlineEditMs: hlEditMs,
			replaceBytes: repBytes,
			hashlineBytes: hlBytes,
			apiCalls,
			totalTokens,
			thinking,
			reason,
			measuredAt: new Date().toISOString(),
		},
	};
}

async function main() {
	const cli = parseCli(process.argv.slice(2));
	const env = await getBenchEnv();
	let cfg;
	try {
		cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
	} catch {
		cfg = structuredClone(env.DEFAULT_CONFIG);
	}
	const threshold = cli.minSpeedup ?? cfg.minSpeedup ?? 1.15;
	const repeats = cli.repeats ?? cfg.benchRepeats ?? DEFAULT_BENCH_REPEATS;
	const policy = resolveOverrunPolicy(cli, cfg);
	cfg.minSpeedup = threshold;
	cfg.stopOnOverrun = Boolean(cfg.stopOnOverrun);
	cfg.calibrated ??= {};

	console.log(
		`Calibrating ${cli.models.length} model(s) in-process at thinking=${cli.thinking}, repeats=${repeats}, minSpeedup=${threshold}x, stopOnOverrun=${policy.stopOnOverrun} ...`,
	);

	const queue = [...cli.models];
	const outcomes = [];
	async function worker() {
		while (queue.length > 0) {
			const m = queue.shift();
			if (!m) break;
			const res = await calibrateModel(
				m,
				cli.thinking,
				threshold,
				cli.progress ? (p) => process.stdout.write(`[PROGRESS] ${JSON.stringify(p)}\n`) : undefined,
				policy,
				repeats,
			);
			outcomes.push(res);
			if (res.skipped) {
				console.log(`  [SKIP] ${m}: ${res.error}`);
			} else {
				const e = res.entry;
				const label = e.use === "hashline" ? "HASHLINE" : "BUILT-IN";
				console.log(
					`  [${label.padEnd(8)}] ${res.model.padEnd(34)} speedup=${String(e.speedup + "x").padEnd(6)} medianMs=${e.replaceEditMs}->${e.hashlineEditMs}  calls=${e.apiCalls} tok=${e.totalTokens}  pass=${e.passReplace}->${e.passHashline}`,
				);
				cfg.calibrated[res.model] = e;
			}
		}
	}

	await Promise.all(Array.from({ length: Math.min(cli.concurrency, cli.models.length) }, () => worker()));

	if (!cli.dryRun) {
		// Re-read config right before atomic write so concurrent UI overrides on other models are preserved!
		let latestCfg = cfg;
		try {
			latestCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
		} catch {}
		latestCfg.minSpeedup = threshold;
		latestCfg.stopOnOverrun = latestCfg.stopOnOverrun === true;
		latestCfg.calibrated ??= {};
		for (const res of outcomes) {
			if (!res.skipped && res.entry) {
				latestCfg.calibrated[res.model] = res.entry;
				if (cli.reset && Array.isArray(latestCfg.rules)) {
					latestCfg.rules = latestCfg.rules.filter(
						(r) => !((r.manual || r.pinned) && String(r.match ?? "").toLowerCase() === res.model),
					);
				}
			}
		}
		fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
		const tmp = `${CONFIG_PATH}.tmp-${process.pid}`;
		fs.writeFileSync(tmp, JSON.stringify(latestCfg, null, 2) + "\n", "utf8");
		fs.renameSync(tmp, CONFIG_PATH);
		console.log(`\nWrote calibrated routing table to ${CONFIG_PATH}`);
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
