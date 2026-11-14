import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const piPkgRoot = path.join(os.homedir(), ".local/share/pi-fork/current/node_modules/@earendil-works/pi-coding-agent");
const piReq = createRequire(path.join(piPkgRoot, "package.json"));
const jitiPath = path.join(os.homedir(), ".local/share/pi-fork/current/node_modules/jiti/lib/jiti.mjs");
const { createJiti } = await import(pathToFileURL(jitiPath).href);
const jiti = createJiti(import.meta.url, {
	fsCache: true,
	alias: {
		"@earendil-works/pi-coding-agent": path.join(piPkgRoot, "dist/index.js"),
		"@earendil-works/pi-tui": path.join(piPkgRoot, "../pi-tui/dist/index.js"),
		typebox: piReq.resolve("typebox"),
	},
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hl-test-"));
process.env.PI_CODING_AGENT_DIR = path.join(tmp, "agent");

const mod = await jiti.import(path.join(import.meta.dirname, "index.ts"));
const cfgMod = await jiti.import(path.join(import.meta.dirname, "config.ts"));
const ext = mod.default;
const { shouldUseHashline } = mod;

// 1. Model-family auto routing + pinned/calibrated precedence in hashline.json
assert.equal(shouldUseHashline("auto", { provider: "antigravity", id: "gemini-4-carbon" }), true);
assert.equal(shouldUseHashline("auto", { provider: "google", id: "gemini-4-argon" }), true);
assert.equal(shouldUseHashline("auto", { provider: "openai-codex", id: "gpt-6-astra" }), true);
assert.equal(shouldUseHashline("auto", { provider: "anthropic", id: "claude-opus-5-5" }), false);
assert.equal(shouldUseHashline("auto", { provider: "kimi-coding", id: "k3.1-pro-highspeed" }), false);
assert.equal(shouldUseHashline("all", { provider: "anthropic", id: "claude-opus-5-5" }), true);
assert.equal(shouldUseHashline("all", { provider: "kimi-coding", id: "k3.1-pro-highspeed" }), false);

// Calibrated entry overrides unpinned family wildcard, and pinned rule overrides calibrated entry
const customCfg = cfgMod.loadConfigSync(process.env.PI_CODING_AGENT_DIR);
customCfg.calibrated["kimi-coding/k3.1-pro-highspeed"] = {
	use: "hashline",
	speedup: 1.65,
	bytesRatio: 2.3,
	passReplace: "2/2",
	passHashline: "2/2",
	replaceEditMs: 8000,
	hashlineEditMs: 4850,
	replaceBytes: 2400,
	hashlineBytes: 1040,
	thinking: "medium",
	reason: "1.65x faster",
	measuredAt: new Date().toISOString(),
};
cfgMod.saveConfigSync(customCfg, process.env.PI_CODING_AGENT_DIR);
assert.equal(shouldUseHashline("auto", { provider: "kimi-coding", id: "k3.1-pro-highspeed" }), true);

customCfg.rules.unshift({ match: "kimi-coding/*", use: "replace", pinned: true });
cfgMod.saveConfigSync(customCfg, process.env.PI_CODING_AGENT_DIR);
assert.equal(shouldUseHashline("auto", { provider: "kimi-coding", id: "k3.1-pro-highspeed" }), false);
customCfg.rules.shift();
delete customCfg.calibrated["kimi-coding/k3.1-pro-highspeed"];
cfgMod.saveConfigSync(customCfg, process.env.PI_CODING_AGENT_DIR);

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

// Activate for Gemini via before_agent_start and verify selectedTools swap
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

// 8. TUI Picker deterministic tests (Speed column blank until benched, built-in naming, Nerd Font gauge, right-aligned token/call hint, accent headers, 0-jitter)
const pickerMod = await jiti.import(path.join(import.meta.dirname, "picker.ts"));
const tuiMod = await jiti.import(path.join(piPkgRoot, "../pi-tui/dist/index.js"));
const { HashlinePickerComponent, GAUGE_ICON, EST_BENCH_HINT, benchHint } = pickerMod;
const { visibleWidth } = tuiMod;

// Verify config.ts also accepts "built-in" in hand-edited JSON rules
assert.equal(
	cfgMod.resolveModelDecision(
		{ version: 1, defaultUse: "built-in", minSpeedup: 1.15, rules: [{ match: "anthropic/*", use: "built-in", pinned: true }], calibrated: {} },
		"auto",
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

const calEntry = (use, passHashline = "2/2", speedup = 2.0, apiCalls = 10, totalTokens = 34200) => ({
	use, speedup, bytesRatio: 5.08, passReplace: "2/2", passHashline,
	replaceEditMs: 16324, hashlineEditMs: 8161, replaceBytes: 4468, hashlineBytes: 879,
	apiCalls, totalTokens,
	thinking: "high", reason: "test", measuredAt: new Date().toISOString(),
});

// Bench hint: average of recorded apiCalls/totalTokens when present; a labelled estimate only when nothing was measured.
const unmeasured = { ...calEntry("replace"), apiCalls: undefined, totalTokens: undefined };
assert.equal(benchHint({ a: calEntry("hashline", "2/2", 2, 9, 40000), b: calEntry("replace", "2/2", 1, 11, 64000), c: unmeasured }), "bench: ~10 calls · ~52k tok (avg of 2)");
for (const cal of [undefined, {}, { c: unmeasured }]) assert.equal(benchHint(cal), EST_BENCH_HINT);
assert.ok(EST_BENCH_HINT.endsWith("(est.)"), EST_BENCH_HINT);
const MEASURED_HINT = "bench: ~10 calls · ~35k tok (avg of 3)";

let closed = false;
const runningJobs = new Map();
const benchErrors = new Map();
let pickerCfg = cfgMod.loadConfigSync(process.env.PI_CODING_AGENT_DIR);
pickerCfg.calibrated["antigravity/gemini-4-argon"] = calEntry("hashline", "2/2", 2.0, 10, 34200);
pickerCfg.calibrated["anthropic/claude-opus-5-5"] = calEntry("replace", "2/2", 0.95, 11, 36800);
pickerCfg.calibrated["zeta-lab/zeta-1"] = calEntry("replace", "0/2", 0.5);
let curOverride = "auto";
let curNow = 1_000_000;

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
	currentModel: catalog[1], // Claude Opus 5.5 current -> selected on open
	usage,
	config: pickerCfg,
	overrideMode: curOverride,
	runningJobs,
	lastBenchErrors: benchErrors,
	now: () => curNow,
	onToggleModel(m, nextUse) {
		const key = `${m.provider}/${m.id}`.toLowerCase();
		pickerCfg.rules = pickerCfg.rules.filter((r) => !(r.pinned && r.match.toLowerCase() === key));
		pickerCfg.rules.unshift({ match: key, use: nextUse, pinned: true });
		return pickerCfg;
	},
	onUnpinModel(m) {
		const key = `${m.provider}/${m.id}`.toLowerCase();
		pickerCfg.rules = pickerCfg.rules.filter((r) => !(r.pinned && r.match.toLowerCase() === key));
		return pickerCfg;
	},
	onCycleOverrideMode() {
		const order = ["auto", "all", "force", "off"];
		curOverride = order[(order.indexOf(curOverride) + 1) % order.length];
		return curOverride;
	},
	onToggleBenchmark(m) {
		const key = `${m.provider}/${m.id}`.toLowerCase();
		if (runningJobs.has(key)) runningJobs.delete(key);
		else runningJobs.set(key, { startedAt: 995_000, gen: 1, doneSteps: 0, totalSteps: 8, apiCalls: 0, totalTokens: 0 });
	},
	onClose() {
		closed = true;
	},
});

const KEY = { enter: "\r", down: "\x1b[B", tab: "\t", ctrlB: "\x02", ctrlS: "\x13", ctrlU: "\x15", ctrlO: "\x0f", ctrlG: "\x07", bksp: "\x7f" };
const HEADER_ROW = 6;
const ROWS = [7, 17];
const allFrames = [];
const render = (w, theme = plainTheme) => {
	const f = picker.render(w, theme);
	allFrames.push(f);
	for (const ln of f) assert.ok(visibleWidth(ln) <= w, `line exceeded width ${w}: ${visibleWidth(ln)} "${ln}"`);
	return f;
};
const xOf = (line, idx) => visibleWidth(line.slice(0, idx));
const EDIT_RE = /(?:\* )?[●○] (?:hashline|built-in|off)/g;
const BENCH_RE = new RegExp(`${GAUGE_ICON} [█▓▒░]{6} \\d+\\/\\d+|✗ failed|✓ hashline|✓ built-in|—`);
const selectedRow = (f) => f.slice(...ROWS).find((l) => l.startsWith("▶ "));

/** Header ends/starts and row cell ends must stay 100% invariant across scrolling, pinning, benching, and sorting. */
function geometry(w) {
	const f = render(w);
	const hdr = f[HEADER_ROW];
	const editEnds = new Set();
	const provStarts = new Set();
	const benchEnds = new Set();
	const speedEnds = new Set();
	const provHdr = hdr.indexOf("Provider");
	const provOff = provHdr < 0 ? -1 : xOf(hdr, provHdr);
	const editHdrMatch = /Edit(?: ▲)?/.exec(hdr);
	const speedHdrMatch = /Speed(?: ▼)?/.exec(hdr);
	const benchHdrMatch = /Bench(?: ▲)?/.exec(hdr);
	const editEnd = editHdrMatch ? xOf(hdr, editHdrMatch.index + editHdrMatch[0].length) : -1;
	const speedEnd = speedHdrMatch ? xOf(hdr, speedHdrMatch.index + speedHdrMatch[0].length) : -1;
	const benchEnd = benchHdrMatch ? xOf(hdr, benchHdrMatch.index + benchHdrMatch[0].length) : -1;

	for (const row of f.slice(...ROWS)) {
		if (!row.trim()) continue;
		const m = [...row.matchAll(EDIT_RE)].pop();
		assert.ok(m, `row without edit cell: "${row}"`);
		editEnds.add(xOf(row, m.index + m[0].length));
		if (provOff >= 0) provStarts.add(xOf(row, row.search(/\[[A-Z]/)));
		const sp = /\d+\.\d{2}×/.exec(row);
		if (sp) speedEnds.add(xOf(row, sp.index + sp[0].length));
		const b = BENCH_RE.exec(row);
		assert.ok(b, `row without bench cell: "${row}"`);
		benchEnds.add(xOf(row, b.index + b[0].length));
	}
	assert.deepEqual([...editEnds], [editEnd], `edit cells misaligned with header at ${w}:\n${f.join("\n")}`);
	if (provOff >= 0) assert.deepEqual([...provStarts], [provOff], `provider cells misaligned at ${w}:\n${f.join("\n")}`);
	if (speedEnds.size > 0 && speedEnd >= 0) assert.deepEqual([...speedEnds], [speedEnd], `speed cells misaligned at ${w}:\n${f.join("\n")}`);
	assert.deepEqual([...benchEnds], [w], `bench cells not right-anchored at ${w}`);
	assert.equal(benchEnd, w, `bench header not right-anchored at ${w}: "${hdr}"`);
	return JSON.stringify({ modelOff: xOf(hdr, hdr.indexOf("Model")), provOff, speedEnd, editEnd, benchEnd, height: f.length });
}

// Initial: Frequent tab, accent headers, right-aligned token/API-call transparency hint on bottom bar.
let f120 = render(120);
const emptySearchLine = f120[5];
assert.ok(emptySearchLine.startsWith("  Search: "));
assert.ok(selectedRow(f120).startsWith("▶ Claude Opus 5.5 ●"), f120.join("\n"));
assert.ok(f120[17].includes("anthropic/claude-opus-5-5 · benchmarked → built-in (11 calls · 36.8k tok)"), f120[17]);
// Bottom bar has key hints on the left and right-justified estimated API calls / token usage on the right!
assert.ok(f120.at(-2).startsWith("  Enter swap · Ctrl+S sort · Ctrl+B bench"), f120.at(-2));
assert.ok(f120.at(-2).endsWith(`${MEASURED_HINT}  `), `bottom bar not right-justified: "${f120.at(-2)}"`);

// Every column header is accent-colored (differentiated from data rows), even when unsorted!
const styledHdrInitial = render(120, markTheme)[HEADER_ROW];
for (const h of ["Model", "Provider", "Speed", "Edit", "Bench"]) {
	assert.ok(styledHdrInitial.includes(`\x1b[35m${h}\x1b[39m`), `header ${h} missing accent color: ${styledHdrInitial}`);
}

// Speed column: shows measured ratio ONLY for benchmarked models (2.00×, 0.95×), completely blank for unbenched (GPT-6 Astra)!
const astraRow = f120.find((l) => l.includes("GPT-6 Astra"));
assert.ok(astraRow && !/\d+\.\d{2}×/.test(astraRow) && astraRow.trimEnd().endsWith("—"), `unbenched row should have blank Speed: "${astraRow}"`);
assert.ok(f120.some((l) => l.includes("Gemini 4 Argon ★ ●") && l.includes("2.00×") && l.includes("● hashline") && l.includes("✓ hashline")));
assert.ok(f120.some((l) => l.includes("Claude Opus 5.5 ●") && l.includes("0.95×") && l.includes("○ built-in") && l.includes("✓ built-in")));

// 0-jitter: header and cell x-offsets identical across scrolling, Enter pin toggles, live gauge ticks, and every Ctrl+S mode.
for (const w of [120, 92]) {
	const base = geometry(w);
	const seen = new Set();
	for (let i = 0; i < 16; i++) {
		picker.handleInput(KEY.down);
		seen.add(selectedRow(render(w)));
		assert.equal(geometry(w), base, `scroll jitter at ${w}`);
	}
	assert.ok(seen.size >= 15, "scrolled through every Frequent row");
	for (const k of [KEY.enter, KEY.enter, KEY.ctrlU, KEY.ctrlB, KEY.ctrlB]) {
		picker.handleInput(k);
		assert.equal(geometry(w), base, `jitter after key ${JSON.stringify(k)} at ${w}`);
	}
	for (let i = 0; i < 6; i++) {
		picker.handleInput(KEY.ctrlS);
		assert.equal(geometry(w), base, `sort jitter at ${w} step ${i}`);
	}
	assert.equal(picker.sortMode, "default");
}

// Enter pins with gold `*`; Ctrl+B renders live Nerd Font gauge (` ... 0/8` -> `4/8` -> `8/8`) and live calls/tokens in bottom bar!
for (let i = 0; i < 20 && !selectedRow(render(120)).includes("Claude Opus 5.5"); i++) picker.handleInput(KEY.down);
picker.handleInput(KEY.enter);
f120 = render(120);
assert.ok(selectedRow(f120).includes("Claude Opus 5.5 ●") && selectedRow(f120).includes("* ● hashline"), f120.join("\n"));
assert.ok(f120[17].includes("pinned → hashline"), f120[17]);
picker.handleInput(KEY.ctrlU);
assert.ok(!selectedRow(render(120)).includes("* "), "unpinned");

picker.handleInput(KEY.ctrlB);
f120 = render(120);
assert.ok(selectedRow(f120).includes(`${GAUGE_ICON} ▒░░░░░ 0/8`), selectedRow(f120));
assert.ok(f120.at(-2).endsWith(`${GAUGE_ICON} 0/~12 calls · ~38k tok est  `), f120.at(-2));
// Simulate live streaming progress from calibrate.mjs (`4/8` steps, 5 API calls, 14.2k tokens)
const runningClaude = runningJobs.get("anthropic/claude-opus-5-5");
runningClaude.doneSteps = 4;
runningClaude.apiCalls = 5;
runningClaude.totalTokens = 14200;
curNow += 500;
f120 = render(120);
assert.ok(selectedRow(f120).includes(`${GAUGE_ICON} ███░░░ 4/8`), selectedRow(f120));
assert.ok(f120.at(-2).endsWith(`${GAUGE_ICON} 5/~12 calls · 14.2k/~38k tok  `), f120.at(-2));
runningClaude.doneSteps = 8;
assert.ok(selectedRow(render(120)).includes(`${GAUGE_ICON} ██████ 8/8`));
picker.handleInput(KEY.ctrlB);

// Ctrl+S cycles sort modes, highlights active label in bold accent + gold arrow, and keeps selection anchored.
const anchor = selectedRow(render(120)).slice(0, 20);
const modes = [];
for (let i = 0; i < 6; i++) {
	picker.handleInput(KEY.ctrlS);
	modes.push(picker.sortMode);
	const f = render(120);
	assert.equal(selectedRow(f).slice(0, 20), anchor, `selection lost after Ctrl+S -> ${picker.sortMode}`);
	const hdr = render(120, markTheme)[HEADER_ROW];
	if (picker.sortMode === "default") {
		// Frequent default has no active arrow (usage order), all headers plain accent
		assert.equal((hdr.match(/[▲▼]/g) ?? []).length, 0, hdr);
	} else {
		const [lbl, arr] = { speed: ["Speed", "▼"], edit: ["Edit", "▲"], bench: ["Bench", "▲"], model: ["Model", "▲"], provider: ["Provider", "▲"] }[picker.sortMode];
		assert.ok(hdr.includes(`\x1b[1m\x1b[35m${lbl}\x1b[39m\x1b[22m\x1b[1m\x1b[33m ${arr}\x1b[39m\x1b[22m`), `active header for ${picker.sortMode}: ${hdr}`);
		assert.equal((hdr.match(/[▲▼]/g) ?? []).length, 1, hdr);
	}
	const rows = f.slice(...ROWS).filter((l) => l.trim());
	if (picker.sortMode === "speed") {
		// Measured ratios sorted desc (2.00× before 0.95×), unbenched rows strictly after!
		const argonIdx = rows.findIndex((l) => l.includes("2.00×"));
		const claudeIdx = rows.findIndex((l) => l.includes("0.95×"));
		const firstBlankIdx = rows.findIndex((l) => !/\d+\.\d{2}×/.test(l));
		assert.ok(argonIdx === 0 && claudeIdx === 1 && firstBlankIdx === 2, rows.join("\n"));
	}
	if (picker.sortMode === "bench") {
		const rank = (l) => ["✓ hashline", "✓ built-in", "✗ failed", "—"].findIndex((s) => l.includes(s));
		assert.ok(rows.every((l, j) => j === 0 || rank(rows[j - 1]) <= rank(l)), rows.join("\n"));
	}
	if (picker.sortMode === "edit") {
		const hl = rows.map((l) => /[●○] hashline/.test(l));
		assert.ok(hl.every((v, j) => j === 0 || hl[j - 1] >= v), rows.join("\n"));
	}
}
assert.deepEqual(modes, ["speed", "edit", "bench", "model", "provider", "default"]);

// Switch toSpeed sort, then test Search query: fuzzy rank governs, arrows hidden; clearing restores Speed ▼.
picker.handleInput(KEY.ctrlS);
assert.equal(picker.sortMode, "speed");
for (const ch of "arg") picker.handleInput(ch);
f120 = render(120);
assert.ok(selectedRow(f120).startsWith("▶ Gemini 4 Argon ★ ●"), f120.join("\n"));
assert.ok(!/[▲▼]/.test(f120[HEADER_ROW]) && f120[HEADER_ROW].includes("Speed"), f120[HEADER_ROW]);
for (let i = 0; i < 3; i++) picker.handleInput(KEY.bksp);
assert.ok(render(120)[HEADER_ROW].includes("Speed ▼"));
// Reset sortMode back to default
for (let i = 0; i < 5; i++) picker.handleInput(KEY.ctrlS);
assert.equal(picker.sortMode, "default");

// Ctrl+O cycles the global mode; Ctrl+G (Zellij unlock) is ignored and never reaches Search.
const modeOf = (f) => /mode: (\w+)/.exec(f[1])[1];
picker.handleInput(KEY.ctrlO);
assert.equal(modeOf(render(120)), "all");
picker.handleInput(KEY.ctrlG);
f120 = render(120);
assert.equal(modeOf(f120), "all");
assert.equal(f120[5], emptySearchLine, "Ctrl+G must not reach Search");
picker.handleInput(KEY.ctrlO);
picker.handleInput(KEY.ctrlO);
f120 = render(120);
assert.equal(modeOf(f120), "off");
assert.ok(f120.slice(...ROWS).filter((l) => l.trim()).every((l) => l.includes("○ off") && !/[●○] hashline/.test(l)));
picker.handleInput(KEY.ctrlO);
assert.equal(modeOf(render(120)), "auto");

// Widths 42/68/92/120 on every tab: header and cells drop in lockstep (speed -> bench -> edit).
for (let t = 0; t < 8; t++) {
	for (const w of [42, 68, 92, 120]) {
		const f = render(w);
		const hdr = f[HEADER_ROW];
		const rows = f.slice(...ROWS).filter((l) => l.trim() && !l.includes("No "));
		assert.equal(hdr.includes("Bench"), rows.some((l) => BENCH_RE.test(l)), `bench lockstep tab ${t} w ${w}`);
		assert.equal(hdr.includes("Edit"), rows.some((l) => /[●○] (?:hashline|built-in|off)/.test(l)) || !rows.length, `edit lockstep tab ${t} w ${w}`);
		if (w === 42) assert.ok(hdr.includes("Edit") && !hdr.includes("Speed") && (!hdr.includes("Provider") || !hdr.includes("Bench")), hdr);
		if (w >= 92) assert.ok(hdr.includes("Speed") && hdr.includes("Bench"), hdr);
	}
	picker.handleInput(KEY.tab);
}

// Single-provider tab (Zeta Lab): no Provider column, Ctrl+S skips 'provider', failed benchmark shows `✗ failed` with blank Speed!
for (let i = 0; i < 7; i++) picker.handleInput(KEY.tab);
const zeta = render(120);
assert.ok(zeta[3].includes("Zeta Lab"));
assert.ok(!zeta[HEADER_ROW].includes("Provider") && !zeta.slice(...ROWS).some((l) => l.includes("[")), zeta.join("\n"));
const zetaARow = zeta.find((l) => l.includes("Zeta A"));
assert.ok(zetaARow && zetaARow.includes("✗ failed") && !/\d+\.\d{2}×/.test(zetaARow), zeta.join("\n"));
const zetaBase = geometry(120);
const zetaModes = [];
for (let i = 0; i < 5; i++) {
	picker.handleInput(KEY.ctrlS);
	zetaModes.push(picker.sortMode);
	assert.equal(geometry(120), zetaBase);
}
assert.deepEqual(zetaModes, ["speed", "edit", "bench", "model", "default"]);

// Never render the counter-intuitive word "replace" or "Uses" anywhere in the UI!
const everything = allFrames.flat().join("\n");
for (const bad of ["replace", "Uses", "untested", "⟳ running"]) {
	assert.ok(!everything.includes(bad), `rendered counter-intuitive text "${bad}"`);
}
for (const good of ["○ built-in", "✓ built-in", "✓ hashline", "2.00×", "0.95×", `${GAUGE_ICON} ███░░░ 4/8`, MEASURED_HINT]) {
	assert.ok(everything.includes(good), `missing expected UI text "${good}"`);
}
assert.equal(new Set(allFrames.filter((f) => f.length > 2).map((f) => f.length)).size, 1, "picker height constant");
assert.ok(render(22).every((l) => visibleWidth(l) <= 22));

// Esc closes cleanly
picker.handleInput("\x1b");
assert.equal(closed, true);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("ALL_PI_HASHLINE_TESTS_PASSED");
