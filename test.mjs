import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// Prefer the repo-local install (what `npm ci` provides in CI); fall back to a local
// pi-fork install when browsing the tree without installing dependencies.
let createJiti, piEntry, tuiEntry, typeboxEntry;
try {
	// ESM resolution: @earendil-works/pi-coding-agent exports only an `import` condition,
	// so require.resolve() fails on it.
	createJiti = (await import("jiti")).createJiti;
	piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	tuiEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-tui"));
	typeboxEntry = fileURLToPath(import.meta.resolve("typebox"));
} catch {
	const piPkgRoot = path.join(os.homedir(), ".local/share/pi-fork/current/node_modules/@earendil-works/pi-coding-agent");
	const piReq = createRequire(path.join(piPkgRoot, "package.json"));
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hl-test-"));
process.env.PI_CODING_AGENT_DIR = path.join(tmp, "agent");

const mod = await jiti.import(path.join(import.meta.dirname, "index.ts"));
const cfgMod = await jiti.import(path.join(import.meta.dirname, "config.ts"));
const ext = mod.default;
const { shouldUseHashline } = mod;

// 1. Routing: installing the extension changes nothing; a model moves to hashline only when the user says so.
for (const model of [
	{ provider: "antigravity", id: "gemini-4-carbon" },
	{ provider: "google", id: "gemini-4-argon" },
	{ provider: "openai-codex", id: "gpt-6-astra" },
	{ provider: "anthropic", id: "claude-opus-5-5" },
	{ provider: "kimi-coding", id: "k3.1-pro-highspeed" },
]) {
	assert.equal(shouldUseHashline(model), false, `${model.provider}/${model.id} must start on the built-in tool`);
}
assert.deepEqual(cfgMod.DEFAULT_CONFIG, { version: 1, defaultUse: "replace", rules: [] });

// A manual choice moves one model, and only that model.
const customCfg = cfgMod.loadConfigSync(process.env.PI_CODING_AGENT_DIR);
assert.deepEqual(customCfg.rules, []);
customCfg.rules.unshift({ match: "kimi-coding/k3.1-pro-highspeed", use: "hashline", manual: true });
cfgMod.saveConfigSync(customCfg, process.env.PI_CODING_AGENT_DIR);
assert.equal(shouldUseHashline({ provider: "kimi-coding", id: "k3.1-pro-highspeed" }), true);
assert.equal(shouldUseHashline({ provider: "kimi-coding", id: "k3.1-pro" }), false);
customCfg.rules.shift();
// A rule the user wrote by hand still applies, and a manual choice still wins over it.
customCfg.rules.push({ match: "kimi-coding/*", use: "hashline" });
cfgMod.saveConfigSync(customCfg, process.env.PI_CODING_AGENT_DIR);
assert.equal(shouldUseHashline({ provider: "kimi-coding", id: "k3.1-pro" }), true);
customCfg.rules.unshift({ match: "kimi-coding/k3.1-pro", use: "replace", manual: true });
cfgMod.saveConfigSync(customCfg, process.env.PI_CODING_AGENT_DIR);
assert.equal(shouldUseHashline({ provider: "kimi-coding", id: "k3.1-pro" }), false);
customCfg.rules = [];
cfgMod.saveConfigSync(customCfg, process.env.PI_CODING_AGENT_DIR);

// A config written by an earlier version: its seeded family rules and benchmark results no longer route anything, and are dropped on save.
const legacyPath = cfgMod.resolveConfigPath(process.env.PI_CODING_AGENT_DIR);
fs.writeFileSync(
	legacyPath,
	JSON.stringify({
		version: 1,
		defaultUse: "replace",
		minSpeedup: 1.15,
		benchRepeats: 2,
		rules: [
			{ match: "anthropic/claude-fable-5", use: "hashline", manual: true, note: "set in /hashline menu" },
			{ match: "anthropic/*", use: "replace", note: "Claude is RL-tuned for tight oldText anchors (97.7% success, 1.3x inflation)" },
			{ match: "*gemini*", use: "hashline", note: "Gemini bloats oldText 4x-22x without line bounds" },
			{ match: "openai-codex/*", use: "hashline" },
			{ match: "*gemini*", use: "built-in", note: "written by hand, not a seeded rule" },
		],
		calibrated: { "anthropic/claude-opus-5-5": { use: "hashline", speedup: 4.25 } },
	}),
);
const legacyCfg = cfgMod.loadConfigSync(process.env.PI_CODING_AGENT_DIR, true, true);
assert.deepEqual(legacyCfg.rules.map((r) => `${r.match}=${r.use}`), ["anthropic/claude-fable-5=hashline", "*gemini*=built-in"]);
assert.equal(cfgMod.resolveModelDecision(legacyCfg, { provider: "openai-codex", id: "gpt-6-astra" }).source, "default", "a seeded family rule no longer routes a model");
assert.equal(cfgMod.resolveModelDecision(legacyCfg, { provider: "anthropic", id: "claude-opus-5-5" }).use, "replace", "an old benchmark verdict no longer routes a model");
assert.equal(cfgMod.resolveModelDecision(legacyCfg, { provider: "anthropic", id: "claude-fable-5" }).use, "hashline", "the user's own choice is kept");
cfgMod.saveConfigSync(legacyCfg, process.env.PI_CODING_AGENT_DIR);
assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(legacyPath, "utf8"))).sort(), ["defaultUse", "rules", "version"]);
// The engine tests below run as a model the user has switched to hashline in the picker.
cfgMod.saveConfigSync(
	{ ...structuredClone(cfgMod.DEFAULT_CONFIG), rules: [{ match: "antigravity/gemini-4-carbon", use: "hashline", manual: true }] },
	process.env.PI_CODING_AGENT_DIR,
);

// 2. Mount extension on a mock Pi API

const handlers = new Map();
const tools = new Map();
ext({
	on(event, fn) {
		const list = handlers.get(event) ?? [];
		list.push(fn);
		handlers.set(event, list);
	},
	registerTool(t) {
		tools.set(t.name, t);
	},
	registerCommand() {},
	registerShortcut() {},
});

const hlTool = tools.get("hashline_edit");
assert.ok(hlTool, "hashline_edit registered");

// A model the user has not switched keeps Pi's stock tools untouched.
const stockOpts = { selectedTools: ["read", "bash", "edit", "write"] };
for (const fn of handlers.get("before_agent_start")) {
	await fn({ messageType: "user", prompt: "refactor", systemPromptOptions: stockOpts }, { cwd: tmp, model: { provider: "google", id: "gemini-4-argon" } });
}
assert.deepEqual(stockOpts.selectedTools, ["read", "bash", "edit", "write"]);

// Activate for the switched model via before_agent_start and verify selectedTools swap
const promptOpts = { selectedTools: ["read", "bash", "edit", "write"] };
for (const fn of handlers.get("before_agent_start")) {
	await fn({ messageType: "user", prompt: "refactor", systemPromptOptions: promptOpts }, {
		cwd: tmp,
		model: { provider: "antigravity", id: "gemini-4-carbon" },
	});
}
assert.deepEqual(promptOpts.selectedTools, ["read", "hashline_edit", "bash", "write"]);

// Switch to Claude and verify selectedTools swaps back to stock edit
for (const fn of handlers.get("before_agent_start")) {
	await fn({ messageType: "user", prompt: "refactor", systemPromptOptions: promptOpts }, {
		cwd: tmp,
		model: { provider: "anthropic", id: "claude-opus-5-5" },
	});
}
assert.ok(promptOpts.selectedTools.includes("edit") && !promptOpts.selectedTools.includes("hashline_edit"));

// Switch back to Gemini for the file operation tests
for (const fn of handlers.get("before_agent_start")) {
	await fn({ messageType: "user", prompt: "refactor", systemPromptOptions: promptOpts }, {
		cwd: tmp,
		model: { provider: "antigravity", id: "gemini-4-carbon" },
	});
}

// 3. Create two files, run partial read on src/svc.py (lines 1..5 of 8) and full read on src/dest.py
fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
const svcPath = path.join(tmp, "src/svc.py");
const destPath = path.join(tmp, "src/dest.py");
const svcText = [
	"@cache",
	"def compute(x):",
	"    return x + 1",
	"",
	"VALUE = 10",
	"UNSEEN_A = 20",
	"UNSEEN_B = 30",
	"UNSEEN_C = 40",
	"",
].join("\n");
fs.writeFileSync(svcPath, svcText, "utf8");
fs.writeFileSync(destPath, "# header\n", "utf8");

// Codemode nested read (`parentToolCallId` set) stays raw!
const rawReadRes = await handlers.get("tool_result")[0](
	{
		toolName: "read",
		parentToolCallId: "cm-1",
		input: { path: "src/dest.py" },
		content: [{ type: "text", text: "# header\n" }],
		isError: false,
	},
	{ cwd: tmp },
);
assert.equal(rawReadRes, undefined, "codemode read stays raw");

// Top-level read of lines 1..5 of src/svc.py gets `[src/svc.py#TAG]` + numbered lines + preserves footer
const visibleSlice = svcText.split("\n").slice(0, 5).join("\n") + "\n\n[3 more lines in file. Use offset=6 to continue.]";
const readSvc = await handlers.get("tool_result")[0](
	{
		toolName: "read",
		input: { path: "src/svc.py", offset: 1, limit: 5 },
		content: [{ type: "text", text: visibleSlice }],
		isError: false,
	},
	{ cwd: tmp },
);
const svcHeaderMatch = /^\[src\/svc\.py#([0-9A-F]{4})\]\n1:@cache/.exec(readSvc.content[0].text);
assert.ok(svcHeaderMatch, `unexpected formatted read: ${readSvc.content[0].text}`);
assert.ok(readSvc.content[0].text.endsWith("[3 more lines in file. Use offset=6 to continue.]"));
const svcTag = svcHeaderMatch[1];

// 4. Seen-line guard rejects editing unseen line 7 before reading it
const unseenAttempt = await hlTool.execute(
	"c1",
	{ input: `[src/svc.py#${svcTag}]\nPUT 7.=7:\n+UNSEEN_B = 999\n` },
	undefined,
	undefined,
	{ cwd: tmp, model: { provider: "antigravity", id: "gemini-4-carbon" } },
);
assert.equal(unseenAttempt.isError, true);
assert.equal(unseenAttempt.details.errorKind, "unseen_lines");

// 5. Block replace (`PUT 1*:`) + line replace (`PUT 5.=5:`) in one unshifted batch succeeds!
const goodEdit = await hlTool.execute(
	"c2",
	{
		input: `[src/svc.py#${svcTag}]\nPUT 1*:\n+@cache\n+def compute(x):\n+    return x * 2\nPUT 5.=5:\n+VALUE = 99\n`,
	},
	undefined,
	undefined,
	{ cwd: tmp, model: { provider: "antigravity", id: "gemini-4-carbon" } },
);
assert.equal(goodEdit.isError, undefined, goodEdit.content[0].text);
const afterSvc = fs.readFileSync(svcPath, "utf8");
assert.ok(afterSvc.includes("return x * 2") && afterSvc.includes("VALUE = 99") && afterSvc.includes("UNSEEN_C = 40"));

// 6a. Disjoint external append at EOF safely recovers via snapshot chain (preserving both edits!)
fs.appendFileSync(svcPath, "EXTERNAL = 1\n", "utf8");
const newTagMatch = /^\[src\/svc\.py#([0-9A-F]{4})\]/.exec(goodEdit.content[0].text);
assert.ok(newTagMatch);
const recoveredAttempt = await hlTool.execute(
	"c3a",
	{ input: `[src/svc.py#${newTagMatch[1]}]\nPUT 5.=5:\n+VALUE = 100\n` },
	undefined,
	undefined,
	{ cwd: tmp, model: { provider: "antigravity", id: "gemini-4-carbon" } },
);
assert.equal(recoveredAttempt.isError, undefined, recoveredAttempt.content[0].text);
assert.ok(fs.readFileSync(svcPath, "utf8").includes("EXTERNAL = 1") && fs.readFileSync(svcPath, "utf8").includes("VALUE = 100"));

// 6b. Conflicting external modification on the target line itself MUST reject (`isError: true`)!
const tagAfterRecover = /^\[src\/svc\.py#([0-9A-F]{4})\]/.exec(recoveredAttempt.content[0].text)[1];
fs.writeFileSync(svcPath, fs.readFileSync(svcPath, "utf8").replace("VALUE = 100", "VALUE = 777"), "utf8");
const conflictingAttempt = await hlTool.execute(
	"c3b",
	{ input: `[src/svc.py#${tagAfterRecover}]\nPUT 5.=5:\n+VALUE = 200\n` },
	undefined,
	undefined,
	{ cwd: tmp, model: { provider: "antigravity", id: "gemini-4-carbon" } },
);
assert.equal(conflictingAttempt.isError, true, "conflicting external modification must reject stale tag");

// 7. Cross-file CUT @fn -> PUT <1 @fn + MV rename
const readDest = await handlers.get("tool_result")[0](
	{
		toolName: "read",
		input: { path: "src/dest.py" },
		content: [{ type: "text", text: "# header\n" }],
		isError: false,
	},
	{ cwd: tmp },
);
const destTag = /^\[src\/dest\.py#([0-9A-F]{4})\]/.exec(readDest.content[0].text)[1];
const freshSvcTxt = fs.readFileSync(svcPath, "utf8");
const readSvcFull = await handlers.get("tool_result")[0](
	{
		toolName: "read",
		input: { path: "src/svc.py" },
		content: [{ type: "text", text: freshSvcTxt }],
		isError: false,
	},
	{ cwd: tmp },
);
const svcTag2 = /^\[src\/svc\.py#([0-9A-F]{4})\]/.exec(readSvcFull.content[0].text)[1];

const moveEdit = await hlTool.execute(
	"c4",
	{
		input: `[src/svc.py#${svcTag2}]\nCUT 1* @fn\n[src/dest.py#${destTag}]\nPUT >1 @fn\nMV src/moved_dest.py\n`,
	},
	undefined,
	undefined,
	{ cwd: tmp, model: { provider: "antigravity", id: "gemini-4-carbon" } },
);
assert.equal(moveEdit.isError, undefined, moveEdit.content[0].text);
assert.equal(fs.existsSync(destPath), false);
assert.ok(fs.readFileSync(path.join(tmp, "src/moved_dest.py"), "utf8").includes("def compute(x):"));

// 8. TUI picker: columns Model, Provider, Speed, Cost, Edit; figures come only from the transcript replay.
const pickerMod = await jiti.import(path.join(import.meta.dirname, "picker.ts"));
const tuiMod = await jiti.import(tuiEntry);
const { HashlinePickerComponent, HashlineDetailPane } = pickerMod;
const { visibleWidth, truncateToWidth } = tuiMod;

// config.ts also accepts "built-in" in hand-edited JSON rules
assert.equal(
	cfgMod.resolveModelDecision(
		{ version: 1, defaultUse: "built-in", rules: [{ match: "anthropic/*", use: "built-in", manual: true }] },
		{ provider: "anthropic", id: "claude-opus-5-5" },
	).use,
	"replace",
);

const plainTheme = { fg: (_c, s) => s, bg: (_c, s) => s, bold: (s) => s };
const markTheme = {
	fg: (c, s) => (c === "accent" ? `\x1b[35m${s}\x1b[39m` : c === "warning" ? `\x1b[33m${s}\x1b[39m` : s),
	bg: (_c, s) => s,
	bold: (s) => `\x1b[1m${s}\x1b[22m`,
};
// Zero-width colour codes for cell colours, so wide rows are not truncated by the markers themselves.
const ansiTheme = {
	fg: (c, s) => (c === "success" ? `\x1b[32m${s}\x1b[39m` : c === "error" ? `\x1b[31m${s}\x1b[39m` : c === "muted" ? `\x1b[90m${s}\x1b[39m` : s),
	bg: (_c, s) => s,
	bold: (s) => s,
};

let closed = false;
let shownDetail;
// The picker fixture uses hand-written family rules so that both tools and the "rule" status appear.
let pickerCfg = {
	version: 1,
	defaultUse: "replace",
	rules: [
		{ match: "anthropic/*", use: "replace" },
		{ match: "*gemini*", use: "hashline" },
		{ match: "openai-codex/*", use: "hashline" },
	],
};

// Replayed figures: Speed and Cost cells come from these rows.
const replayRow = (model, timeSavedPct, costSavedPct, replayed = 600, extra = {}) => ({
	model, responses: 1000, spend: 100, responseSeconds: 5000, tokensPerSecond: 80, bytesPerToken: 3, cacheRate: 0.95,
	edits: { ok: replayed + 20, failed: 12, notFound: 7, notUnique: 4, replayed, viaCodemode: 20 },
	reads: { total: 900, measured: 900, perEdit: 1.5, avgLines: 80 },
	hashline: { calls: 0, failed: 0, failKinds: {} },
	outputPerEdit: { builtin: 677, hashline: 516 }, inputPerRead: 268,
	timeSavedSeconds: 50, timeSavedPct, secondsPerEdit: 1.7, costSaved: -3, costSavedPct,
	breakdown: { outputTokens: -1000, inputTokensOnce: 2000, inputTokenTurns: 90000, fromReads: { once: 1, turns: 1 }, fromEdits: { once: 1, turns: 1 }, pricePerMillion: { output: 20, freshInput: 5, laterInput: 0.4 } },
	failedEditTokens: 100, speedEdits: replayed, costEdits: replayed, speedSettled: replayed >= 100, costSettled: replayed >= 100, ...extra,
});
const replayTable = (...rows) => ({ version: 1, generatedAt: "", sessionsDir: "", sessionFiles: 0, resultModel: { perNewLine: 0.2, perOp: 11, source: "test" }, rows });
const testReplay = replayTable(replayRow("antigravity/gemini-4-argon", 6.3, -2.6), replayRow("anthropic/claude-opus-5-5", 0.9, -3.8));
const PCT_RE = /(?:[+-]\d+\.\d%|0\.0%)/g;
const hasPct = (l) => /(?:[+-]\d+\.\d%|0\.0%)/.test(l);

const catalog = [
	{ provider: "openai-codex", id: "gpt-6-astra", name: "GPT-6 Astra" },
	{ provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5" },
	{ provider: "antigravity", id: "gemini-4-argon", name: "Gemini 4 Argon" },
	{ provider: "kimi-coding", id: "k3.1-pro-highspeed", name: "Kimi K3.1 Pro Highspeed" },
	...Array.from({ length: 12 }, (_, i) => ({
		provider: "zeta-lab",
		id: `zeta-${i + 1}`,
		name: i === 11 ? "Zeta Ultra Long Reasoning Model Preview Edition" : `Zeta ${String.fromCharCode(65 + i)}${"x".repeat(i)}`,
	})),
];

const usage = {
	counts: new Map([
		["openai-codex/gpt-6-astra", 432],
		["anthropic/claude-opus-5-5", 388],
		["antigravity/gemini-4-argon", 223],
		...Array.from({ length: 12 }, (_, i) => [`zeta-lab/zeta-${i + 1}`, i + 1]),
	]),
	favorites: new Set(["antigravity/gemini-4-argon"]),
};

const picker = new HashlinePickerComponent({
	allModels: catalog,
	currentModel: catalog[1], // Claude Opus 5.5 is the active model -> selected on open
	usage,
	config: pickerCfg,
	replay: testReplay,
	onToggleModel(m, nextUse) {
		const key = `${m.provider}/${m.id}`.toLowerCase();
		pickerCfg.rules = pickerCfg.rules.filter((r) => !(r.manual && r.match.toLowerCase() === key));
		pickerCfg.rules.unshift({ match: key, use: nextUse, manual: true });
		return pickerCfg;
	},
	onResetModel(m) {
		const key = `${m.provider}/${m.id}`.toLowerCase();
		pickerCfg.rules = pickerCfg.rules.filter((r) => !(r.manual && r.match.toLowerCase() === key));
		return pickerCfg;
	},
	onShowDetail(model, detail) {
		shownDetail = { model, detail };
	},
	onClose() {
		closed = true;
	},
});

const KEY = { enter: "\r", down: "\x1b[B", tab: "\t", shiftTab: "\x1b[Z", ctrlB: "\x02", ctrlD: "\x04", ctrlR: "\x12", ctrlX: "\x18", ctrlS: "\x13", ctrlG: "\x07", bksp: "\x7f" };
// The frame's lines: title rule, tabs, rule, search, column headers, ten rows, status, rule, keys, rule.
const TITLE_ROW = 0;
const TABS_ROW = 1;
const SEARCH_ROW = 3;
const HEADER_ROW = 4;
const ROWS = [5, 15];
const STATUS_ROW = 15;
const KEYS = "  Enter swap · Ctrl+D detail · Ctrl+R reset · Ctrl+S sort · Tab · Esc";
/** The key bar: hints on the left, the selected model's notes right-aligned two columns in from the edge. */
const bar = (f) => f.at(-2);
const allFrames = [];
const render = (w, theme = plainTheme) => {
	const f = picker.render(w, theme);
	allFrames.push(f);
	for (const ln of f) assert.ok(visibleWidth(ln) <= w, `line exceeded width ${w}: ${visibleWidth(ln)} "${ln}"`);
	return f;
};
const xOf = (line, idx) => visibleWidth(line.slice(0, idx));
const EDIT_RE = /[●○] (?:hashline|built-in)/g;
const selectedRow = (f) => f.slice(...ROWS).find((l) => l.startsWith("▶ "));
const sortUntil = (mode) => {
	for (let i = 0; i < 14 && picker.sortMode !== mode; i++) picker.handleInput(KEY.ctrlS);
	assert.equal(picker.sortMode, mode);
};

/**
 * Header ends/starts and row cell ends must stay identical across scrolling, toggling, and sorting.
 * Edit is the last column and ends where the picker's text ends: at the right edge up to 128 columns, at column 128
 * on a wider screen, and centred with Speed and Cost once the terminal's midline has passed them.
 */
const RIGHT_COLS_W = "Speed ▼".length + 2 + "+99.9%".length + 2 + "● hashline".length;
const editEndAt = (w) => (w <= 128 ? w : Math.max(128, Math.ceil((w + RIGHT_COLS_W) / 2)));
assert.deepEqual([92, 120, 128, 129, 200, 229, 230, 260].map(editEndAt), [92, 120, 128, 128, 128, 128, 129, 144]);
assert.deepEqual([92, 128, 200, 260].map(pickerMod.contentWidth), [92, 128, 128, 144]);
function geometry(w) {
	const edge = editEndAt(w);
	const f = render(w);
	const hdr = f[HEADER_ROW];
	const editEnds = new Set();
	const provStarts = new Set();
	const speedEnds = new Set();
	const costEnds = new Set();
	const provHdr = hdr.indexOf("Provider");
	const provOff = provHdr < 0 ? -1 : xOf(hdr, provHdr);
	const end = (re) => {
		const m = re.exec(hdr);
		return m ? xOf(hdr, m.index + m[0].length) : -1;
	};
	const editEnd = end(/Edit(?: [▲▼])?/);
	const speedEnd = end(/Speed(?: [▲▼])?/);
	const costEnd = end(/Cost(?: [▲▼])?/);
	for (const row of f.slice(...ROWS)) {
		if (!row.trim()) continue;
		const m = [...row.matchAll(EDIT_RE)].pop();
		assert.ok(m, `row without edit cell: "${row}"`);
		editEnds.add(xOf(row, m.index + m[0].length));
		if (provOff >= 0) provStarts.add(xOf(row, row.search(/\[[A-Z]/)));
		const [sp, sv] = [...row.matchAll(PCT_RE)];
		if (sp) speedEnds.add(xOf(row, sp.index + sp[0].length));
		if (sv) costEnds.add(xOf(row, sv.index + sv[0].length));
	}
	assert.deepEqual([...editEnds], [edge], `edit cells do not end at ${edge} in ${w} columns:\n${f.join("\n")}`);
	assert.equal(editEnd, edge, `edit header does not end at ${edge} in ${w} columns: "${hdr}"`);
	if (provOff >= 0) assert.deepEqual([...provStarts], [provOff], `provider cells misaligned at ${w}:\n${f.join("\n")}`);
	if (speedEnds.size > 0 && speedEnd >= 0) assert.deepEqual([...speedEnds], [speedEnd], `speed cells misaligned at ${w}:\n${f.join("\n")}`);
	if (costEnds.size > 0 && costEnd >= 0) assert.deepEqual([...costEnds], [costEnd], `cost cells misaligned at ${w}:\n${f.join("\n")}`);
	return JSON.stringify({ modelOff: xOf(hdr, hdr.indexOf("Model")), provOff, speedEnd, costEnd, editEnd, height: f.length });
}

// Initial frame: Frequent tab, the active model selected, key hints only on the bottom bar.
let f120 = render(120);
const emptySearchLine = f120[SEARCH_ROW];
assert.ok(emptySearchLine.startsWith("  Search: "));
assert.ok(f120[TABS_ROW].includes("Frequent") && f120[TABS_ROW].includes("All") && !f120[TABS_ROW].includes("Benchmarked"), f120[TABS_ROW]);
assert.ok(selectedRow(f120).startsWith("▶ Claude Opus 5.5 ●"), f120.join("\n"));
assert.equal(f120[STATUS_ROW].trimEnd(), "  (2/15) anthropic/claude-opus-5-5");
assert.ok(bar(f120).startsWith(`${KEYS}  `) && bar(f120).endsWith("  rule (anthropic) → built-in"), bar(f120));
assert.equal(visibleWidth(bar(f120)), 118, "notes end two columns before the right edge");
assert.ok(bar(render(60)).startsWith(KEYS.slice(0, 50)) && !bar(render(60)).includes("→"), "a narrow key bar holds keys only");
assert.ok(render(60)[STATUS_ROW].includes("rule (anthropic)"), "notes that do not fit beside the keys stay on the status line");
assert.equal(f120.length, 19);
assert.ok(f120[TITLE_ROW].startsWith("─ Hashline Edit Routing ───") && f120[TITLE_ROW].endsWith("─── 2 replayed ─"), f120[TITLE_ROW]);
assert.equal(visibleWidth(f120[TITLE_ROW]), 120, "the title line is the top rule");

// Every column header is accent-coloured, even when unsorted.
const styledHdrInitial = render(120, markTheme)[HEADER_ROW];
for (const h of ["Model", "Provider", "Speed", "Cost", "Edit"]) {
	assert.ok(styledHdrInitial.includes(`\x1b[35m${h}\x1b[39m`), `header ${h} missing accent color: ${styledHdrInitial}`);
}

// Speed and Cost appear only for models with replayed edits; Edit shows the current tool for every model.
const astraRow = f120.find((l) => l.includes("GPT-6 Astra"));
assert.ok(astraRow && !hasPct(astraRow) && astraRow.trimEnd().endsWith("● hashline"), `row without replay data should have blank Speed/Cost: "${astraRow}"`);
assert.ok(f120.some((l) => l.includes("Gemini 4 Argon ●") && l.includes("+6.3%") && l.includes("+2.6%") && l.trimEnd().endsWith("● hashline")));
assert.ok(f120.some((l) => l.includes("Claude Opus 5.5 ●") && l.includes("+0.9%") && l.includes("+3.8%") && l.trimEnd().endsWith("○ built-in")));

// Dots are as sparse as in pi-picks: only the active model (green) and favorites (gold) carry one, and nothing shows a star.
const dotted = f120.slice(...ROWS).map((l) => /^[▶ ] ([^[]+?) ●\s+\[/.exec(l)?.[1]).filter(Boolean).sort();
assert.deepEqual(dotted, ["Claude Opus 5.5", "Gemini 4 Argon"], f120.join("\n"));
assert.ok(!f120.join("\n").includes("★"));
assert.ok(render(120, markTheme).find((l) => l.includes("Gemini 4 Argon")).includes("\x1b[33m\x1b[1m ●"), "a favorite's dot is gold");

// Settled figures need no comment; anything else gets the same plain sentence, on the key bar when it fits and on the status line when it does not.
assert.ok(!f120[STATUS_ROW].includes("so far") && !bar(f120).includes("so far"), f120[STATUS_ROW]);
picker.handleInput(KEY.down);
picker.handleInput(KEY.down);
assert.ok(render(120)[STATUS_ROW].endsWith(" · 0 edits replayed so far; figures settle as you work") && !bar(render(120)).includes("so far"), render(120)[STATUS_ROW]);
assert.ok(bar(render(300)).includes("  0 edits replayed so far; figures settle as you work · ") && !render(300)[STATUS_ROW].includes(" · "), bar(render(300)));
picker.syncState({ replay: replayTable(replayRow("antigravity/gemini-4-argon", 6.3, -2.6), replayRow("anthropic/claude-opus-5-5", 0.9, -3.8, 1137, { speedSettled: false })) });
for (let i = 0; i < 20 && !selectedRow(render(120)).includes("Claude Opus 5.5"); i++) picker.handleInput(KEY.down);
assert.ok(render(120)[STATUS_ROW].endsWith("anthropic/claude-opus-5-5 · 1,137 edits replayed so far; figures settle as you work") && bar(render(120)).endsWith("  rule (anthropic) → built-in"), render(120)[STATUS_ROW]);
assert.ok(bar(render(130)).endsWith("  1,137 edits replayed so far; figures settle as you work") && render(130)[STATUS_ROW].endsWith("anthropic/claude-opus-5-5 · rule (anthropic) → built-in"), bar(render(130)));
assert.ok(bar(render(300)).endsWith("  1,137 edits replayed so far; figures settle as you work · rule (anthropic) → built-in") && render(300)[STATUS_ROW].endsWith("anthropic/claude-opus-5-5"), bar(render(300)));
// The shared frame on its own: plain text in, the same line order and height whatever a tool gives it.
{
	const frameMod = await jiti.import(path.join(import.meta.dirname, "frame.ts"));
	const plain = { accent: (t) => t, bold: (t) => t, border: (t) => t };
	const cells = { width: visibleWidth, truncate: (t, w) => truncateToWidth(t, w) };
	const parts = { title: "Title", badge: "busy", tabs: "  A │ B", input: "  Search: ", header: "  Name", rows: ["▶ one", "  two"], status: "  (1/2) one", keys: "  Enter · Esc" };
	const at = (w, term = w, p = parts) => frameMod.frameLines(p, w, term, plain, cells);
	assert.equal(at(60).length, 9 + frameMod.FRAME_ROWS);
	assert.equal(at(60)[0], `─ Title ${"─".repeat(45)} busy ─`);
	assert.equal(at(60, 60, { ...parts, badge: undefined })[0], `─ Title ${"─".repeat(52)}`);
	assert.equal(at(16)[0], `─ Title ${"─".repeat(8)}`, "a badge that leaves no rule beside the title is dropped");
	assert.equal(at(128, 200)[0], `─ Title ${"─".repeat(113)} busy ${"─".repeat(73)}`, "past the badge the rule runs to the terminal's edge");
	assert.deepEqual(at(128, 200).map((l) => visibleWidth(l) > 128), [true, false, true, ...Array(13).fill(false), true, false, true]);
	assert.deepEqual(at(60, 60, { ...parts, rows: Array(14).fill("  row") }).slice(5, 15), Array(10).fill("  row"), "never more than FRAME_ROWS rows");
	assert.equal(frameMod.spread("left", "right", 20, cells), "left         right");
	assert.equal(frameMod.spread("left", "right", 12, cells), undefined);
	assert.deepEqual([100, 128, 129, 200, 300].map((w) => frameMod.contentWidth(w, 28)), [100, 128, 128, 128, 164]);
	// frame.ts is one file kept as an identical copy in each tool of the suite. Where a sibling checkout sits beside
	// this one (a development machine, not CI), the copies must match.
	const mine = fs.readFileSync(path.join(import.meta.dirname, "frame.ts"), "utf8");
	for (const rel of ["../pi-picks/frame.ts", "../pi-speech/src/pi/frame.ts"]) {
		const sibling = path.join(import.meta.dirname, rel);
		if (fs.existsSync(sibling)) assert.equal(fs.readFileSync(sibling, "utf8"), mine, `frame.ts differs from ${rel}: copy the newer file over the older`);
	}
}

// A wide screen: only the rules and the title line run the full width; the title badge, tabs, rows, status line and key bar stop where the Edit column ends.
const wide = render(252);
const wideEnd = editEndAt(252);
assert.equal(wideEnd, 140);
for (const [i, ln] of wide.entries()) {
	if (/^─+$/.test(ln) || i === TITLE_ROW) assert.equal(visibleWidth(ln), 252, `rule ${i} spans the terminal`);
	else assert.ok(visibleWidth(ln.trimEnd()) <= wideEnd, `line ${i} runs past column ${wideEnd}: "${ln}"`);
}
assert.equal(wide.filter((ln) => /^─+$/.test(ln)).length, 3);
assert.equal(visibleWidth(wide[TITLE_ROW].slice(0, wide[TITLE_ROW].indexOf("replayed") + "replayed".length)), wideEnd - 2, wide[TITLE_ROW]);
assert.ok(/replayed ─+$/.test(wide[TITLE_ROW]), "the rule runs on past the badge to the terminal's edge");
assert.equal(visibleWidth(bar(wide)), wideEnd - 2, bar(wide));
assert.equal(picker.paneOffsetX(52), Math.floor((wideEnd - 52) / 2), "the detail pane is centred over the text, not the terminal");
render(120);
assert.equal(picker.paneOffsetX(52), undefined);
picker.syncState({ replay: testReplay });

// 0-jitter: header and cell x-offsets identical across scrolling, Enter toggles, Ctrl+R reset and every Ctrl+S mode.
for (const w of [120, 92, 200, 260]) {
	const base = geometry(w);
	const seen = new Set();
	for (let i = 0; i < 16; i++) {
		picker.handleInput(KEY.down);
		seen.add(selectedRow(render(w)));
		assert.equal(geometry(w), base, `scroll jitter at ${w}`);
	}
	assert.ok(seen.size >= 15, "scrolled through every Frequent row");
	for (const k of [KEY.enter, KEY.enter, KEY.ctrlR]) {
		picker.handleInput(k);
		assert.equal(geometry(w), base, `jitter after key ${JSON.stringify(k)} at ${w}`);
	}
	for (let i = 0; i < 11; i++) {
		picker.handleInput(KEY.ctrlS);
		assert.equal(geometry(w), base, `sort jitter at ${w} step ${i}`);
	}
	assert.equal(picker.sortMode, "default");
}

// The keys the suite's pickers share: PageDown and Shift+↓ jump ten rows without wrapping, PageUp and Shift+↑ go back.
{
	const at = () => /\((\d+)\/(\d+)\)/.exec(render(120)[STATUS_ROW]).slice(1).map(Number);
	for (let i = 0; i < 40 && at()[0] !== 1; i++) picker.handleInput("\x1b[A");
	const total = at()[1];
	assert.ok(total > 10, "the fixture tab has more than one page");
	picker.handleInput("\x1b[6~");
	assert.equal(at()[0], 11, "PageDown");
	picker.handleInput("\x1b[6~");
	assert.equal(at()[0], Math.min(21, total), "PageDown stops at the last row");
	picker.handleInput("\x1b[5~");
	picker.handleInput("\x1b[1;2A");
	assert.equal(at()[0], 1, "PageUp and Shift+↑ stop at the first row");
	picker.handleInput("\x1b[1;2B");
	assert.equal(at()[0], 11, "Shift+↓");
}

// Enter sets a manual override; Ctrl+R (and Ctrl+X) clears it.
for (let i = 0; i < 20 && !selectedRow(render(120)).includes("Claude Opus 5.5"); i++) picker.handleInput(KEY.down);
picker.handleInput(KEY.enter);
f120 = render(120);
assert.ok(selectedRow(f120).trimEnd().endsWith("● hashline"), f120.join("\n"));
assert.ok(bar(f120).endsWith("  manual → hashline"), bar(f120));
picker.handleInput(KEY.ctrlR);
f120 = render(120);
assert.ok(selectedRow(f120).trimEnd().endsWith("○ built-in") && bar(f120).includes("rule (anthropic) → built-in"), `${selectedRow(f120)} | ${bar(f120)}`);
picker.handleInput(KEY.enter);
picker.handleInput(KEY.ctrlX);
assert.ok(bar(render(120)).includes("rule (anthropic) → built-in"));
// Ctrl+B once ran a benchmark; it is no longer bound to anything.
const beforeCtrlB = render(120);
picker.handleInput(KEY.ctrlB);
assert.deepEqual(render(120), beforeCtrlB);

// Ctrl+S cycles every visible column ▲ then ▼ left to right with no dead presses, accurate arrows, and anchored selection.
const EXPECTED_HDR = {
	"model-asc": ["Model", "▲"],
	"model-desc": ["Model", "▼"],
	"provider-asc": ["Provider", "▲"],
	"provider-desc": ["Provider", "▼"],
	"time-asc": ["Speed", "▲"],
	"time-desc": ["Speed", "▼"],
	"cost-asc": ["Cost", "▲"],
	"cost-desc": ["Cost", "▼"],
	"edit-asc": ["Edit", "▲"],
	"edit-desc": ["Edit", "▼"],
};
const anchor = selectedRow(render(120)).slice(0, 20);
const modes = [];
let prevHdr = render(120, markTheme)[HEADER_ROW];
for (let i = 0; i < 11; i++) {
	picker.handleInput(KEY.ctrlS);
	modes.push(picker.sortMode);
	const f = render(120);
	assert.equal(selectedRow(f).slice(0, 20), anchor, `selection lost after Ctrl+S -> ${picker.sortMode}`);
	const hdr = render(120, markTheme)[HEADER_ROW];
	assert.notEqual(hdr, prevHdr, `Ctrl+S step ${i} (${picker.sortMode}) did not change header`);
	prevHdr = hdr;
	if (picker.sortMode === "default") {
		assert.equal((hdr.match(/[▲▼]/g) ?? []).length, 0, hdr);
	} else {
		const [lbl, arr] = EXPECTED_HDR[picker.sortMode];
		assert.ok(hdr.includes(`\x1b[1m\x1b[35m${lbl}\x1b[39m\x1b[22m\x1b[1m\x1b[33m ${arr}\x1b[39m\x1b[22m`), `active header for ${picker.sortMode}: ${hdr}`);
		assert.equal((hdr.match(/[▲▼]/g) ?? []).length, 1, hdr);
	}
	const rows = f.slice(...ROWS).filter((l) => l.trim());
	const idx = (text) => rows.findIndex((l) => l.includes(text));
	const firstBlank = rows.findIndex((l) => !hasPct(l));
	// Models with figures come first in either direction; the order between them follows the number shown.
	if (picker.sortMode === "time-desc") assert.ok(idx("+6.3%") === 0 && idx("+0.9%") === 1 && firstBlank === 2, rows.join("\n"));
	if (picker.sortMode === "time-asc") assert.ok(idx("+0.9%") === 0 && idx("+6.3%") === 1 && firstBlank === 2, rows.join("\n"));
	if (picker.sortMode === "cost-desc") assert.ok(idx("+3.8%") === 0 && idx("+2.6%") === 1 && firstBlank === 2, rows.join("\n"));
	if (picker.sortMode === "cost-asc") assert.ok(idx("+2.6%") === 0 && idx("+3.8%") === 1 && firstBlank === 2, rows.join("\n"));
	if (picker.sortMode === "edit-desc" || picker.sortMode === "edit-asc") {
		const hl = rows.map((l) => /● hashline/.test(l));
		assert.ok(hl.every((v, j) => j === 0 || (picker.sortMode === "edit-desc" ? hl[j - 1] >= v : hl[j - 1] <= v)), rows.join("\n"));
	}
}
assert.deepEqual(modes, ["model-asc", "model-desc", "provider-asc", "provider-desc", "time-asc", "time-desc", "cost-asc", "cost-desc", "edit-asc", "edit-desc", "default"]);

// Search: fuzzy rank governs while typing (arrows hidden), Ctrl+S during search sorts the matches, and clearing restores the prior sort.
sortUntil("time-desc");
for (const ch of "arg") picker.handleInput(ch);
f120 = render(120);
assert.ok(selectedRow(f120).startsWith("▶ Gemini 4 Argon ●"), f120.join("\n"));
assert.ok(!/[▲▼]/.test(f120[HEADER_ROW]) && f120[HEADER_ROW].includes("Speed"), f120[HEADER_ROW]);
for (let i = 0; i < 3; i++) picker.handleInput(KEY.bksp);
assert.ok(render(120)[HEADER_ROW].includes("Speed ▼"));
for (const ch of "zeta") picker.handleInput(ch);
assert.ok(!/[▲▼]/.test(render(120)[HEADER_ROW]));
picker.handleInput(KEY.ctrlS);
assert.equal(picker.sortMode, "model-asc");
assert.ok(render(120)[HEADER_ROW].includes("Model ▲"));
picker.handleInput(KEY.ctrlS);
assert.equal(picker.sortMode, "model-desc");
assert.ok(render(120)[HEADER_ROW].includes("Model ▼"));
for (let i = 0; i < 4; i++) picker.handleInput(KEY.bksp);
sortUntil("default");

// The All tab has no separate default order, so it shows Model ▲ and the first Ctrl+S is not a dead press.
const TAB_COUNT = 7; // Frequent, All and five providers
picker.handleInput(KEY.tab); // -> All
assert.equal(picker.sortMode, "model-asc");
picker.handleInput(KEY.ctrlS);
assert.equal(picker.sortMode, "model-desc");
for (let i = 0; i < TAB_COUNT - 1; i++) picker.handleInput(KEY.tab); // back to Frequent
assert.ok(render(120)[TABS_ROW].includes("Frequent"));
sortUntil("default");

// Ctrl+G (Zellij unlock) is ignored and never reaches Search.
picker.handleInput(KEY.ctrlG);
assert.equal(render(120)[SEARCH_ROW], emptySearchLine, "Ctrl+G must not reach Search");

// Widths 42/68/92/120 on every tab: header and cells drop in lockstep (Cost first; Edit always stays).
for (let t = 0; t < TAB_COUNT; t++) {
	for (const w of [42, 68, 92, 120]) {
		const f = render(w);
		const hdr = f[HEADER_ROW];
		const rows = f.slice(...ROWS).filter((l) => l.trim() && !l.includes("No "));
		assert.equal(hdr.includes("Edit"), rows.some((l) => /[●○] (?:hashline|built-in)/.test(l)) || !rows.length, `edit lockstep tab ${t} w ${w}`);
		if (w === 42) assert.ok(hdr.includes("Edit") && !hdr.includes("Cost"), hdr);
		if (w >= 92) assert.ok(hdr.includes("Speed") && hdr.includes("Cost") && hdr.includes("Edit"), hdr);
	}
	picker.handleInput(KEY.tab);
}

// Single-provider tab (Zeta Lab): no Provider column, and Ctrl+S skips it.
for (let i = 0; i < TAB_COUNT - 1; i++) picker.handleInput(KEY.tab);
const zeta = render(120);
assert.ok(zeta[TABS_ROW].includes("Zeta Lab"));
assert.ok(!zeta[HEADER_ROW].includes("Provider") && !zeta.slice(...ROWS).some((l) => l.includes("[")), zeta.join("\n"));
const zetaBase = geometry(120);
const zetaModes = [];
assert.equal(picker.sortMode, "model-asc");
for (let i = 0; i < 8; i++) {
	picker.handleInput(KEY.ctrlS);
	zetaModes.push(picker.sortMode);
	assert.equal(geometry(120), zetaBase);
}
assert.deepEqual(zetaModes, ["model-desc", "time-asc", "time-desc", "cost-asc", "cost-desc", "edit-asc", "edit-desc", "model-asc"]);
// Narrower widths drop Cost first, then Speed; Ctrl+S only cycles the columns still shown.
const cycleAt = (w, presses) => {
	render(w);
	const seen = [];
	for (let i = 0; i < presses; i++) {
		picker.handleInput(KEY.ctrlS);
		seen.push(picker.sortMode);
	}
	return seen;
};
assert.ok(render(42)[HEADER_ROW].includes("Speed") && !render(42)[HEADER_ROW].includes("Cost"));
assert.deepEqual(cycleAt(42, 6), ["model-desc", "time-asc", "time-desc", "edit-asc", "edit-desc", "model-asc"]);
assert.ok(!render(30)[HEADER_ROW].includes("Speed") && render(30)[HEADER_ROW].includes("Edit"));
assert.deepEqual(cycleAt(30, 4), ["model-desc", "edit-asc", "edit-desc", "model-asc"]);

// Provider tab where the active model is not first alphabetically: it is listed first, with no misleading Model ▲ until Ctrl+S.
render(120);
picker.syncState({ allModels: [...catalog, { provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" }] });
picker.handleInput(KEY.tab); // Zeta Lab -> Frequent
sortUntil("default");
picker.handleInput(KEY.tab); // All
picker.handleInput(KEY.tab); // Anthropic
const anthDefault = render(120);
assert.ok(anthDefault[TABS_ROW].includes("Anthropic"));
assert.equal(picker.sortMode, "default");
assert.ok(!/[▲▼]/.test(anthDefault[HEADER_ROW]), `expected no arrow when the active model is first: ${anthDefault[HEADER_ROW]}`);
const anthRowsDefault = anthDefault.slice(...ROWS).filter((l) => l.trim());
assert.ok(anthRowsDefault[0].includes("Claude Opus 5.5") && anthRowsDefault[1].includes("Claude Haiku 4.5"), anthRowsDefault.join("\n"));
picker.handleInput(KEY.ctrlS);
const anthAsc = render(120);
assert.equal(picker.sortMode, "model-asc");
assert.ok(anthAsc[HEADER_ROW].includes("Model ▲"), anthAsc[HEADER_ROW]);
const anthRowsAsc = anthAsc.slice(...ROWS).filter((l) => l.trim());
assert.ok(anthRowsAsc[0].includes("Claude Haiku 4.5") && anthRowsAsc[1].includes("Claude Opus 5.5"), anthRowsAsc.join("\n"));

// Wording: never "replace", and nothing left over from the removed benchmark.
const everything = allFrames.flat().join("\n");
for (const bad of ["replace", "Uses", "untested", "running", "pinned", "unpin", "bench", "Bench", "Recommended", "★", "✓", "✗"]) {
	assert.ok(!everything.includes(bad), `rendered unwanted text "${bad}"`);
}
for (const good of ["○ built-in", "● hashline", "+6.3%", "+3.8%", "manual → hashline", "rule (anthropic) → built-in"]) {
	assert.ok(everything.includes(good), `missing expected UI text "${good}"`);
}
assert.equal(new Set(allFrames.filter((f) => f.length > 2).map((f) => f.length)).size, 1, "picker height constant");
assert.ok(render(22).every((l) => visibleWidth(l) <= 22));

// Speed and Cost are green when hashline is better (faster, or a negative cost change), red when worse, neutral at zero, dim while unsettled.
picker.syncState({
	config: { version: 1, defaultUse: "built-in", rules: [{ match: "antigravity/gemini-4-argon", use: "hashline", manual: true }] },
	replay: replayTable(
		replayRow("antigravity/gemini-4-argon", 6.3, 1.2),
		replayRow("anthropic/claude-opus-5-5", -0.4, -3.8),
		replayRow("openai-codex/gpt-6-astra", 0.04, -0.02),
		replayRow("kimi-coding/k3.1-pro-highspeed", 4.2, -1.1, 31),
	),
});
picker.handleInput(KEY.shiftTab); // Anthropic -> All
assert.ok(render(120)[TABS_ROW].includes("All"));
const colored = render(200, ansiTheme);
const rowOf = (frame, name) => frame.find((l) => l.includes(name)) ?? "";
assert.ok(rowOf(colored, "Gemini 4 Argon").includes("\x1b[32m+6.3%") && rowOf(colored, "Gemini 4 Argon").includes("\x1b[32m-1.2%"), rowOf(colored, "Gemini 4 Argon"));
assert.ok(rowOf(colored, "Claude Opus 5.5").includes("\x1b[31m-0.4%") && rowOf(colored, "Claude Opus 5.5").includes("\x1b[31m+3.8%"), rowOf(colored, "Claude Opus 5.5"));
assert.ok(rowOf(colored, "GPT-6 Astra").includes("\x1b[90m0.0%"), rowOf(colored, "GPT-6 Astra"));
const kimiThin = rowOf(colored, "Kimi K3.1");
assert.ok(kimiThin.includes("+4.2%") && kimiThin.includes("+1.1%") && !kimiThin.includes("\x1b[32m+4.2%") && !kimiThin.includes("\x1b[31m+1.1%"), `unsettled figures are not coloured: ${kimiThin}`);

// Ctrl+D hands the selected model's detail to a floating pane; the list itself never changes shape.
for (let i = 0; i < 20 && !selectedRow(render(120)).includes("Gemini 4 Argon"); i++) picker.handleInput(KEY.down);
const listFrame = render(120);
picker.handleInput(KEY.ctrlD);
assert.deepEqual(render(120), listFrame, "the list is untouched while the pane is open");
assert.equal(shownDetail?.model.id, "gemini-4-argon");
assert.equal(shownDetail.detail.title, "Gemini 4 Argon");
let paneClosed = 0;
const paneLines = (detail, theme = plainTheme) => new HashlineDetailPane(detail, theme, () => paneClosed++).render(52);
let pane = paneLines(shownDetail.detail);
for (const l of pane) assert.equal(visibleWidth(l), 52, `pane line is not 52 wide: "${l}"`);
assert.deepEqual(
	pane.map((l) => l.trimEnd()),
	[
		"╭─ Gemini 4 Argon ─────────────────────────────────╮",
		"│                                                  │",
		"│ Speed     +6.3%   1.7 s per edit                 │",
		"│ Cost      -1.2%   of $100 spent                  │",
		"│                                                  │",
		"│ Built-in  1.9%    of 632 edits failed            │",
		"│ Hashline  —       never used                     │",
		"│                                                  │",
		"╰─ 600 edits replayed ─────────────────────────────╯",
	],
);
// Settled figures are coloured by whether hashline is better; unsettled ones are dim; hashline failures show once it has been used.
const paneAnsi = paneLines(
	{ title: "Claude Opus 5.5", row: replayRow("anthropic/claude-opus-5-5", 0.9, -3.8, 1137, { speedSettled: false, hashline: { calls: 66, failed: 17, failKinds: {} } }) },
	ansiTheme,
).join("\n");
assert.ok(paneAnsi.includes("+0.9%") && !paneAnsi.includes("\x1b[32m+0.9%"), "an unsettled Speed is not green");
assert.ok(paneAnsi.includes("\x1b[31m+3.8%"), "a settled cost increase is red");
assert.ok(paneAnsi.includes("25.8%") && paneAnsi.includes("of 66 calls failed") && paneAnsi.includes("of 1,169 edits failed"), paneAnsi);
pane = paneLines({ title: "Zeta A", row: undefined });
assert.ok(pane.join("\n").includes("No edits replayed yet.") && pane.at(-1).startsWith("╰──"), pane.join("\n"));
assert.ok(paneLines({ title: "A very long model name that cannot fit in a narrow pane at all", row: undefined }).every((l) => visibleWidth(l) === 52));
new HashlineDetailPane(shownDetail.detail, plainTheme, () => paneClosed++).handleInput("x");
assert.equal(paneClosed, 1, "any key closes the pane");
assert.equal(closed, false, "closing the pane does not close the picker");

// Sorted by Speed or Cost, the Edit cell is judged on that one measure: green when the current tool is the better one, red when not.
picker.syncState({
	replay: replayTable(
		replayRow("antigravity/gemini-4-argon", 6.3, -2.0), // faster with hashline, but costs more
		replayRow("anthropic/claude-opus-5-5", -0.4, -3.8), // slower and costlier with hashline
		replayRow("openai-codex/gpt-6-astra", 5.0, 3.0, 40), // too few edits to judge
		// Cost is settled, but the few edits with a recorded duration leave Speed unsettled.
		replayRow("kimi-coding/k3.1-pro-highspeed", 9.0, 2.0, 400, { speedEdits: 30, speedSettled: false }),
	),
});
const editCellOf = (frame, name) => {
	const m = /\x1b\[(32|31|90)m([●○] (?:hashline|built-in))\x1b\[39m/.exec(rowOf(frame, name));
	return m ? `[${{ 32: "G", 31: "R", 90: "N" }[m[1]]}:${m[2]}]` : undefined;
};
sortUntil("time-desc");
let basisFrame = render(200, ansiTheme);
assert.equal(editCellOf(basisFrame, "Gemini 4 Argon"), "[G:● hashline]", "on hashline, and hashline is faster");
assert.equal(editCellOf(basisFrame, "Claude Opus 5.5"), "[G:○ built-in]", "on built-in, and built-in is faster");
assert.equal(editCellOf(basisFrame, "GPT-6 Astra"), "[N:○ built-in]", "no verdict from too few edits");
assert.equal(editCellOf(basisFrame, "Zeta A"), "[N:○ built-in]", "no verdict without replay data");
assert.equal(editCellOf(basisFrame, "Kimi K3.1"), "[N:○ built-in]", "Speed is not settled, whatever Cost is");
const kimiMixed = rowOf(basisFrame, "Kimi K3.1");
assert.ok(kimiMixed.includes("+9.0%") && !kimiMixed.includes("\x1b[32m+9.0%") && kimiMixed.includes("\x1b[32m-2.0%"), `each figure is dimmed on its own: ${JSON.stringify(kimiMixed)}`);
assert.ok(basisFrame[STATUS_ROW].includes("faster tool") && basisFrame[STATUS_ROW].includes("slower tool"), basisFrame[STATUS_ROW]);
sortUntil("cost-asc");
basisFrame = render(200, ansiTheme);
assert.equal(editCellOf(basisFrame, "Gemini 4 Argon"), "[R:● hashline]", "on hashline, but built-in is cheaper");
assert.equal(editCellOf(basisFrame, "Claude Opus 5.5"), "[G:○ built-in]", "on built-in, and built-in is cheaper");
assert.equal(editCellOf(basisFrame, "Kimi K3.1"), "[R:○ built-in]", "Cost is settled: on built-in while hashline is cheaper");
assert.ok(basisFrame[STATUS_ROW].includes("cheaper tool") && basisFrame[STATUS_ROW].includes("costlier tool"), basisFrame[STATUS_ROW]);
sortUntil("edit-desc");
basisFrame = render(200, ansiTheme);
assert.equal(editCellOf(basisFrame, "Gemini 4 Argon"), "[G:● hashline]", "other sorts keep the plain hashline/built-in colours");
assert.equal(editCellOf(basisFrame, "Claude Opus 5.5"), "[N:○ built-in]");
assert.ok(!basisFrame[STATUS_ROW].includes("tool") && !basisFrame[STATUS_ROW].includes("●"), `no legend unless the Edit column is being judged: ${basisFrame[STATUS_ROW]}`);

// Esc closes cleanly
picker.handleInput("\x1b");
assert.equal(closed, true);

// 9. The real menu: choices are written to hashline.json, the replay table reaches an open menu, and Ctrl+D opens a floating pane.
const { openHashlineMenu } = pickerMod;
const overlays = [];
const makeMenuCtx = (onMount) => ({
	model: catalog[0], // GPT-6 Astra
	modelRegistry: { refresh: () => Promise.resolve(), getAvailable: () => catalog },
	ui: {
		notify() {},
		custom: (fn, options) =>
			new Promise((resolve) => {
				let renders = 0;
				const tui = { requestRender() { renders++; } };
				const comp = fn(tui, plainTheme, null, resolve);
				// A floating pane is recorded apart from the menu it opens over.
				if (options?.overlay) overlays.push({ comp, options });
				else onMount({ comp, getRenders: () => renders });
			}),
	},
});
const agentDirForMenu = process.env.PI_CODING_AGENT_DIR;
cfgMod.saveConfigSync(structuredClone(cfgMod.DEFAULT_CONFIG), agentDirForMenu);
let menu;
const menuDone = openHashlineMenu({ ctx: makeMenuCtx((x) => (menu = x)) });
assert.ok(selectedRow(menu.comp.render(120)).startsWith("▶ GPT-6 Astra ●"));
// A fresh install: every model is on the built-in tool, and the key bar says it is the default.
assert.ok(menu.comp.render(120).slice(...ROWS).filter((l) => l.trim()).every((l) => l.trimEnd().endsWith("○ built-in")));
assert.ok(menu.comp.render(120).at(-2).endsWith("  default → built-in"), menu.comp.render(120).at(-2));
menu.comp.handleInput(KEY.enter);
assert.ok(selectedRow(menu.comp.render(120)).trimEnd().endsWith("● hashline"));
assert.deepEqual(cfgMod.loadConfigSync(agentDirForMenu, false, true).rules, [{ match: "openai-codex/gpt-6-astra", use: "hashline", manual: true, note: "set in /hashline menu" }]);
const rendersBeforeReset = menu.getRenders();
menu.comp.handleInput(KEY.ctrlR);
assert.ok(menu.getRenders() > rendersBeforeReset, "Ctrl+R must requestRender");
assert.ok(selectedRow(menu.comp.render(120)).trimEnd().endsWith("○ built-in"));
assert.deepEqual(cfgMod.loadConfigSync(agentDirForMenu, false, true).rules, []);
// The background replay of the (empty) sessions directory finishes and is saved next to the config.
await new Promise((r) => setTimeout(r, 50));
assert.ok(fs.existsSync(path.join(agentDirForMenu, "hashline-replay.json")));
// Ctrl+D opens the detail as a floating pane over the list rows, and closing it leaves the menu open.
menu.comp.handleInput(KEY.ctrlD);
assert.equal(overlays.length, 1);
assert.deepEqual(overlays[0].options, { overlay: true, overlayOptions: { anchor: "bottom-center", width: 52, offsetY: -6 } });
assert.ok(overlays[0].comp.render(52)[0].startsWith("╭─ GPT-6 Astra "), overlays[0].comp.render(52)[0]);
overlays[0].comp.handleInput("\x1b");
await new Promise((r) => setImmediate(r));
assert.ok(selectedRow(menu.comp.render(120)).includes("GPT-6 Astra"), "the menu is still there after the pane closes");
menu.comp.handleInput("\x1b");
await menuDone;

// 10. Transcript replay: the hashline call for a recorded patch, read overhead, context lifetime up to compaction, and caching.
const replayMod = await jiti.import(path.join(import.meta.dirname, "replay.ts"));
assert.deepEqual(replayMod.hashlineFromPatch("--- a.ts\n+++ a.ts\n@@ -1,6 +1,6 @@\n l1\n-l2\n-l3\n+L2\n l4\n-l5\n l6\n+tail", "a.ts"), {
	input: "[a.ts#0000]\nPUT 2.=3:\n+L2\nCUT 5.=5\nPUT <7:\n+tail",
	ops: 3,
	newLines: 2,
	lineBytes: 12 / 5,
});
assert.equal(replayMod.hashlineFromPatch("--- a\n+++ a\n@@ -3,1 +3,1 @@\n-x\n+-dash", "a").input, "[a#0000]\nPUT 3.=3:\n+-dash", "a leading dash is escaped");
assert.equal(replayMod.readOverheadBytes(3, 1, "a.ts"), 4 + 8 + 3 * 2);
assert.equal(replayMod.readOverheadBytes(12, 95, "a.ts"), 4 + 8 + 5 * 3 + 7 * 4, "prefix width follows the line number");

const replaySessionsDir = path.join(tmp, "replay-sessions", "--w--");
fs.mkdirSync(replaySessionsDir, { recursive: true });
const usageOf = (output) => ({ input: 100, output, cacheRead: 900, cacheWrite: 0, reasoning: 0, cost: { input: 0.0002, output: output * 0.00001, cacheRead: 0.00018, cacheWrite: 0, total: 0.00038 + output * 0.00001 } });
const assistant = (id, content, output = 50) => ({ type: "message", id, message: { role: "assistant", provider: "P", model: "M", usage: usageOf(output), durationMs: 1000, content } });
const toolResult = (id, toolCallId, toolName, text, extra = {}) => ({ type: "message", id, message: { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], ...extra } });
const editArgs = { path: "a.ts", edits: [{ oldText: "l2", newText: "L2" }] };
fs.writeFileSync(
	path.join(replaySessionsDir, "s.jsonl"),
	[
		{ type: "session", version: 3, id: "s", cwd: "/w" },
		assistant("a1", [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "a.ts" } }]),
		toolResult("t1", "r1", "read", "l1\nl2\nl3"),
		assistant("a2", [{ type: "toolCall", id: "e1", name: "edit", arguments: editArgs }]),
		toolResult("t2", "e1", "edit", "Successfully replaced 1 block(s) in a.ts.", { details: { patch: "--- a.ts\n+++ a.ts\n@@ -1,3 +1,3 @@\n l1\n-l2\n+L2\n l3" } }),
		assistant("a3", [{ type: "text", text: "done" }]),
		{ type: "compaction", id: "c1", firstKeptEntryId: "a3", summary: "" },
		assistant("a4", [{ type: "text", text: "next" }]),
		assistant("a5", [{ type: "toolCall", id: "e2", name: "edit", arguments: editArgs }]),
		toolResult("t3", "e2", "edit", "Could not find edits[0] in a.ts.", { isError: true }),
		assistant("a6", [{ type: "toolCall", id: "h1", name: "hashline_edit", arguments: { input: "[a.ts#1A2B]\nPUT 9.=9:\n+x" } }]),
		toolResult("t4", "h1", "hashline_edit", "anchors to lines never read", { isError: true, details: { errorKind: "unseen_lines" } }),
	]
		.map((e) => JSON.stringify(e))
		.join("\n") + "\n",
);
const partial = (await replayMod.replayFile(path.join(replaySessionsDir, "s.jsonl")))["p/m"];
assert.deepEqual(
	[partial.responses, partial.reads, partial.readsMeasured, partial.readLines, partial.editsOk, partial.editsReplayed, partial.editsFailed, partial.editsNotFound, partial.hashlineCalls, partial.hashlineFailed],
	[6, 1, 1, 3, 1, 1, 1, 1, 1, 1],
);
assert.deepEqual(partial.hashlineFailKinds, { unseen_lines: 1 });
// The read is re-sent to two responses (a2, a3) before the compaction drops it: billed once fresh, then once more.
assert.deepEqual(partial.readContext, [18, 18]);
// The edit reaches one response (a3) before the compaction: billed once, never re-read.
const callDelta = Buffer.byteLength(JSON.stringify({ input: "[a.ts#0000]\nPUT 2.=2:\n+L2" })) - Buffer.byteLength(JSON.stringify(editArgs));
assert.deepEqual(partial.editContext, [callDelta - "Successfully replaced 1 block(s) in a.ts.".length, 0]);
assert.equal(partial.hashlineCallBytes - partial.builtinCallBytes, callDelta);
assert.equal(partial.editResultTurns[0], 0);

const replayCache = path.join(tmp, "replay-cache.json");
const table1 = await replayMod.replaySessions({ sessionsDir: path.join(tmp, "replay-sessions"), cachePath: replayCache });
assert.equal(table1.sessionFiles, 1);
const replayed = table1.rows.find((r) => r.model === "p/m");
assert.ok(replayed && replayed.edits.replayed === 1 && replayed.edits.failed === 1 && replayed.speedSettled === false && replayed.costSettled === false, JSON.stringify(replayed));
assert.deepEqual([replayed.speedEdits, replayed.costEdits], [1, 1]);
assert.equal(replayed.cacheRate, 0.9);
assert.equal(replayed.timeSavedPct, null, "no time figure without responses long enough to measure a rate");
assert.equal(replayed.costSavedPct, null, "no cost figure without a measured bytes-per-token");
assert.ok(fs.existsSync(replayCache));
const table2 = await replayMod.replaySessions({ sessionsDir: path.join(tmp, "replay-sessions"), cachePath: replayCache });
assert.deepEqual(table2.rows, table1.rows, "a cached replay gives the same rows");
replayMod.saveReplayTable(table1, tmp);
assert.deepEqual(replayMod.loadReplayTable(tmp).rows, JSON.parse(JSON.stringify(table1.rows)));

// Speed only counts edits from responses that recorded a duration; older sessions still count toward everything else.
assert.deepEqual([partial.timedEditsOk, partial.timedEditsReplayed, partial.timedCallDelta], [1, 1, callDelta]);
const untimed = (e) => (e.message?.role === "assistant" ? { ...e, message: { ...e.message, durationMs: undefined } } : e);
fs.writeFileSync(
	path.join(replaySessionsDir, "old.jsonl"),
	fs.readFileSync(path.join(replaySessionsDir, "s.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.stringify(untimed(JSON.parse(l)))).join("\n") + "\n",
);
const oldPartial = (await replayMod.replayFile(path.join(replaySessionsDir, "old.jsonl")))["p/m"];
assert.deepEqual([oldPartial.editsOk, oldPartial.editsReplayed, oldPartial.timedEditsOk, oldPartial.timedEditsReplayed, oldPartial.timedCallDelta, oldPartial.durationMs], [1, 1, 0, 0, 0, 0]);
fs.rmSync(path.join(replaySessionsDir, "old.jsonl"));

// A seed file injects sums computed elsewhere: merged into every replay, listed as imported, and skipped when absent, disabled or from another version.
const elsewhere = path.join(tmp, "elsewhere", "--x--");
fs.mkdirSync(elsewhere, { recursive: true });
fs.copyFileSync(path.join(replaySessionsDir, "s.jsonl"), path.join(elsewhere, "other-machine.jsonl"));
fs.copyFileSync(path.join(replaySessionsDir, "s.jsonl"), path.join(elsewhere, "s.jsonl"));
const known = new Set(["s.jsonl"]);
const collected = await replayMod.collectPartials(path.join(tmp, "elsewhere"), known);
assert.equal(collected.files, 1, "a session file name already counted is not counted again");
assert.ok(known.has("other-machine.jsonl"));
const seedPath = path.join(tmp, "replay-seed.json");
assert.equal(collected.units.length, 1, "one session lands in one unit");
fs.writeFileSync(seedPath, JSON.stringify({ version: replayMod.REPLAY_VERSION, generatedAt: "", sources: [{ label: "another machine", files: collected.files, units: collected.units }] }));
const seeded = await replayMod.replaySessions({ sessionsDir: path.join(tmp, "replay-sessions"), cachePath: replayCache, seedPath });
assert.deepEqual(seeded.imported, [{ label: "another machine", files: 1 }]);
const seededRow = seeded.rows.find((r) => r.model === "p/m");
assert.deepEqual([seededRow.edits.replayed, seededRow.edits.failed, seededRow.responses, seededRow.hashline.calls], [2, 2, 12, 2]);
const unseeded = await replayMod.replaySessions({ sessionsDir: path.join(tmp, "replay-sessions"), cachePath: replayCache, seedPath: null });
assert.equal(unseeded.imported, undefined);
assert.equal(unseeded.rows.find((r) => r.model === "p/m").edits.replayed, 1);
fs.writeFileSync(seedPath, JSON.stringify({ version: replayMod.REPLAY_VERSION + 1, sources: [{ label: "future", files: 1, units: collected.units }] }));
assert.equal((await replayMod.replaySessions({ sessionsDir: path.join(tmp, "replay-sessions"), cachePath: replayCache, seedPath })).imported, undefined, "a seed from another version is ignored");

// A figure is settled when redrawn sessions agree on its sign, and never on fewer than 30 edits.
const longAssistant = (id, content) => ({ type: "message", id, message: { role: "assistant", provider: "Q", model: "N", usage: usageOf(400), durationMs: 4000, content } });
const writeSessions = (dir, count, shape) => {
	fs.mkdirSync(dir, { recursive: true });
	// In the mixed shape the long line is sized so the two kinds of edit roughly cancel out.
	const wide = "x".repeat(shape === "mixed" ? 630 : 300);
	for (let i = 0; i < count; i++) {
		// "saves": a long oldText that hashline never writes. "costs": a two-character change inside a long line that hashline must rewrite.
		const saves = shape === "saves" || (shape === "mixed" && i % 2 === 0);
		const args = saves ? { path: "a.ts", edits: [{ oldText: "old ".repeat(150), newText: "new" }] } : { path: "a.ts", edits: [{ oldText: "ab", newText: "ac" }] };
		const patch = saves ? "--- a.ts\n+++ a.ts\n@@ -1,3 +1,3 @@\n l1\n-old\n+new\n l3" : `--- a.ts\n+++ a.ts\n@@ -1,3 +1,3 @@\n l1\n-${wide}ab\n+${wide}ac\n l3`;
		fs.writeFileSync(
			path.join(dir, `s${i}.jsonl`),
			[
				{ type: "session", version: 3, id: `s${i}`, cwd: "/w" },
				longAssistant("a1", [{ type: "text", text: "t".repeat(1600) }]),
				longAssistant("a2", [{ type: "toolCall", id: "e1", name: "edit", arguments: args }]),
				toolResult("t2", "e1", "edit", "Successfully replaced 1 block(s) in a.ts.", { details: { patch } }),
				longAssistant("a3", [{ type: "text", text: "t".repeat(1600) }]),
			]
				.map((e) => JSON.stringify(e))
				.join("\n") + "\n",
		);
	}
};
const settledOf = async (name, count, shape) => {
	const dir = path.join(tmp, name, "--w--");
	writeSessions(dir, count, shape);
	const run = () => replayMod.replaySessions({ sessionsDir: path.join(tmp, name), cachePath: null, seedPath: null });
	const row = (await run()).rows.find((r) => r.model === "q/n");
	assert.deepEqual((await run()).rows.find((r) => r.model === "q/n"), row, "the verdict is the same on every run");
	return row;
};
const agree = await settledOf("settled-agree", 40, "saves");
assert.ok(agree.timeSavedPct > 0 && agree.speedSettled === true && agree.costSettled === true, JSON.stringify([agree.timeSavedPct, agree.costSavedPct, agree.speedSettled, agree.costSettled]));
const few = await settledOf("settled-few", 12, "saves");
assert.ok(few.timeSavedPct > 0 && few.speedSettled === false && few.costSettled === false, "12 edits settle nothing, however one-sided");
const mixed = await settledOf("settled-mixed", 40, "mixed");
assert.ok(mixed.edits.replayed === 40 && mixed.speedSettled === false, `sessions that disagree leave the figure unsettled: ${mixed.timeSavedPct}`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("ALL_PI_HASHLINE_TESTS_PASSED");
