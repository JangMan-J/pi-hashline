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

const mod = await jiti.import(path.resolve("index.ts"));
const cfgMod = await jiti.import(path.resolve("config.ts"));
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

// 8. TUI Picker deterministic tests (header row geometry, sort cycle, hotkeys, honest bench verdicts)
const pickerMod = await jiti.import(path.resolve("picker.ts"));
const tuiMod = await jiti.import(path.join(piPkgRoot, "../pi-tui/dist/index.js"));
const { HashlinePickerComponent } = pickerMod;
const { visibleWidth } = tuiMod;

const plainTheme = { fg: (_c, s) => s, bg: (_c, s) => s, bold: (s) => s };
// Marks bold+accent so the active sorted header is observable (only used for header-style checks).
const markTheme = { fg: (c, s) => (c === "accent" ? `\x1b[36m${s}\x1b[39m` : s), bg: (_c, s) => s, bold: (s) => `\x1b[1m${s}\x1b[22m` };

const calEntry = (use, passHashline = "2/2", speedup = 2.0) => ({
	use, speedup, bytesRatio: 5.08, passReplace: "2/2", passHashline,
	replaceEditMs: 16324, hashlineEditMs: 8161, replaceBytes: 4468, hashlineBytes: 879,
	thinking: "high", reason: "test", measuredAt: new Date().toISOString(),
});

let closed = false;
const runningJobs = new Map();
const benchErrors = new Map();
let pickerCfg = cfgMod.loadConfigSync(process.env.PI_CODING_AGENT_DIR);
pickerCfg.calibrated["antigravity/gemini-4-argon"] = calEntry("hashline");
pickerCfg.calibrated["anthropic/claude-opus-5-5"] = calEntry("replace", "2/2", 0.95);
pickerCfg.calibrated["zeta-lab/zeta-1"] = calEntry("replace", "0/2", 0.5);
let curOverride = "auto";

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
	now: () => 1_000_000,
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
		else runningJobs.set(key, { startedAt: 995_000, gen: 1 });
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
const EDIT_RE = /(?:\* )?[●○] (?:hashline|replace|off)/g;
const BENCH_RE = /⟳ running…|✗ error|✓ faster|✓ keep replace|untested/;
const selectedRow = (f) => f.slice(...ROWS).find((l) => l.startsWith("▶ "));

/** Header x-offsets plus every row's Edit end / Provider start / Bench end; must be identical across actions. */
function geometry(w) {
	const f = render(w);
	const hdr = f[HEADER_ROW];
	const off = {};
	for (const label of ["Model", "Provider", "Uses", "Edit", "Bench"]) {
		const i = hdr.indexOf(label);
		off[label] = i < 0 ? -1 : xOf(hdr, i);
	}
	const editEnds = new Set();
	const provStarts = new Set();
	const benchEnds = new Set();
	for (const row of f.slice(...ROWS)) {
		if (!row.trim()) continue;
		const m = [...row.matchAll(EDIT_RE)].pop();
		assert.ok(m, `row without edit cell: "${row}"`);
		editEnds.add(xOf(row, m.index + m[0].length));
		if (off.Provider >= 0) provStarts.add(xOf(row, row.search(/\[[A-Z]/)));
		const b = BENCH_RE.exec(row);
		assert.ok(b, `row without bench cell: "${row}"`);
		benchEnds.add(xOf(row, b.index + b[0].length));
	}
	assert.deepEqual([...editEnds], [off.Edit + 6], `edit cells misaligned with header at ${w}:\n${f.join("\n")}`);
	if (off.Provider >= 0) assert.deepEqual([...provStarts], [off.Provider], `provider cells misaligned at ${w}:\n${f.join("\n")}`);
	assert.deepEqual([...benchEnds], [w], `bench cells not right-anchored at ${w}`);
	return JSON.stringify({ off, height: f.length });
}

// Initial: Frequent tab, Claude (current) selected, header row replaces the blank spacer.
let f120 = render(120);
const emptySearchLine = f120[5];
assert.ok(emptySearchLine.startsWith("  Search: "));
assert.match(f120[HEADER_ROW], /^ {2}Model ▲? *Provider *Uses ▼ +Edit +Bench +$/);
assert.ok(selectedRow(f120).startsWith("▶ Claude Opus 5.5 ●"), f120.join("\n"));
assert.ok(f120[17].includes("anthropic/claude-opus-5-5 · benchmarked → keep replace"), f120[17]);
assert.ok(f120.at(-2).includes("Enter swap · Ctrl+S sort · Ctrl+B bench · Ctrl+U unpin · Ctrl+O mode · Tab tabs · Esc close"));
// Frequent default sort: Uses ▼ (GPT-6 Astra 432 first), plain counts with gold-star favourite.
assert.ok(f120[7].includes("GPT-6 Astra") && /  432  /.test(f120[7]), f120[7]);
assert.ok(f120.some((l) => l.includes("Gemini 4 Argon") && l.includes("★ 223") && l.includes("✓ faster")));
assert.ok(f120.some((l) => l.includes("Claude Opus 5.5") && l.includes("✓ keep replace") && l.includes("○ replace")));

// 0-jitter: header and cell x-offsets identical across scrolling, Enter pin toggles, Ctrl+B and every Ctrl+S mode.
for (const w of [120, 90]) {
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

// Enter pins the current selection with gold `*`; Ctrl+U unpins; Ctrl+B shows a fixed-width running cell.
for (let i = 0; i < 20 && !selectedRow(render(120)).includes("Claude Opus 5.5"); i++) picker.handleInput(KEY.down);
picker.handleInput(KEY.enter);
f120 = render(120);
assert.ok(selectedRow(f120).includes("Claude Opus 5.5 ●") && selectedRow(f120).includes("* ● hashline"), f120.join("\n"));
assert.ok(f120[17].includes("pinned → hashline"), f120[17]);
picker.handleInput(KEY.ctrlU);
assert.ok(!selectedRow(render(120)).includes("* "), "unpinned");
picker.handleInput(KEY.ctrlB);
assert.ok(selectedRow(render(120)).includes("⟳ running…"));
picker.handleInput(KEY.ctrlB);

// Ctrl+S cycles sort modes, highlights the active header, and keeps the selection anchored on fullId.
const anchor = selectedRow(render(120)).slice(0, 20);
const modes = [];
for (let i = 0; i < 6; i++) {
	picker.handleInput(KEY.ctrlS);
	modes.push(picker.sortMode);
	const f = render(120);
	assert.equal(selectedRow(f).slice(0, 20), anchor, `selection lost after Ctrl+S -> ${picker.sortMode}`);
	const hdr = render(120, markTheme)[HEADER_ROW];
	const expectHdr = { uses: "Uses ▼", edit: "Edit ▲", bench: "Bench ▲", model: "Model ▲", provider: "Provider ▲", default: "Uses ▼" }[picker.sortMode];
	assert.ok(hdr.includes(`\x1b[1m\x1b[36m${expectHdr}\x1b[39m\x1b[22m`), `active header for ${picker.sortMode}: ${hdr}`);
	assert.equal((hdr.match(/[▲▼]/g) ?? []).length, 1, hdr);
	const rows = f.slice(...ROWS).filter((l) => l.trim());
	if (picker.sortMode === "bench") {
		const rank = (l) => ["✓ faster", "✓ keep replace", "✗ error", "untested"].findIndex((s) => l.includes(s));
		assert.ok(rows.every((l, j) => j === 0 || rank(rows[j - 1]) <= rank(l)), rows.join("\n"));
	}
	if (picker.sortMode === "edit") {
		const hl = rows.map((l) => /[●○] hashline/.test(l));
		assert.ok(hl.every((v, j) => j === 0 || hl[j - 1] >= v), rows.join("\n"));
	}
}
assert.deepEqual(modes, ["uses", "edit", "bench", "model", "provider", "default"]);

// Search query: fuzzy rank governs, all headers dim without arrows; clearing restores the arrow.
for (const ch of "arg") picker.handleInput(ch);
f120 = render(120);
assert.ok(selectedRow(f120).startsWith("▶ Gemini 4 Argon ●"), f120.join("\n"));
assert.ok(!/[▲▼]/.test(f120[HEADER_ROW]) && f120[HEADER_ROW].includes("Uses"), f120[HEADER_ROW]);
assert.ok(!render(120, markTheme)[HEADER_ROW].includes("\x1b[1m"));
for (let i = 0; i < 3; i++) picker.handleInput(KEY.bksp);
assert.ok(render(120)[HEADER_ROW].includes("Uses ▼"));

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

// Widths 42/68/90/120 on every tab: header and cells drop in lockstep (uses -> bench -> edit).
for (let t = 0; t < 8; t++) {
	for (const w of [42, 68, 90, 120]) {
		const f = render(w);
		const hdr = f[HEADER_ROW];
		const rows = f.slice(...ROWS).filter((l) => l.trim() && !l.includes("No "));
		assert.equal(hdr.includes("Bench"), rows.some((l) => BENCH_RE.test(l)), `bench lockstep tab ${t} w ${w}`);
		assert.equal(hdr.includes("Edit"), rows.some((l) => /[●○] (?:hashline|replace|off)/.test(l)) || !rows.length, `edit lockstep tab ${t} w ${w}`);
		if (w === 42) assert.ok(hdr.includes("Edit") && !hdr.includes("Uses") && !hdr.includes("Bench"), hdr);
		if (w >= 90) assert.ok(hdr.includes("Uses") && hdr.includes("Bench"), hdr);
	}
	picker.handleInput(KEY.tab);
}

// Single-provider tab (Zeta Lab): no Provider column, Ctrl+S skips 'provider'.
for (let i = 0; i < 7; i++) picker.handleInput(KEY.tab);
const zeta = render(120);
assert.ok(zeta[3].includes("Zeta Lab"));
assert.ok(!zeta[HEADER_ROW].includes("Provider") && !zeta.slice(...ROWS).some((l) => l.includes("[")), zeta.join("\n"));
assert.ok(zeta.some((l) => l.includes("Zeta A") && l.includes("✗ error")), zeta.join("\n"));
const zetaBase = geometry(120).replace(/"Provider":-1/, "");
const zetaModes = [];
for (let i = 0; i < 5; i++) {
	picker.handleInput(KEY.ctrlS);
	zetaModes.push(picker.sortMode);
	assert.equal(geometry(120).replace(/"Provider":-1/, ""), zetaBase);
}
assert.deepEqual(zetaModes, ["uses", "edit", "bench", "model", "default"]);

// Honest provenance only: no multipliers or `×` suffixes anywhere; plain counts and verdicts present.
const everything = allFrames.flat().join("\n");
for (const bad of ["2.00x", "0.95x", "5.1x", "×", "x↓"]) assert.ok(!everything.includes(bad), `rendered "${bad}"`);
for (const good of ["432", "★ 223", "✓ faster", "✓ keep replace", "✗ error", "untested", "rule (openai-codex) → hashline"]) {
	assert.ok(everything.includes(good), `missing "${good}"`);
}
assert.equal(new Set(allFrames.filter((f) => f.length > 2).map((f) => f.length)).size, 1, "picker height constant");
assert.ok(render(22).every((l) => visibleWidth(l) <= 22));

// Esc closes cleanly
picker.handleInput("\x1b");
assert.equal(closed, true);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("ALL_PI_HASHLINE_TESTS_PASSED");
