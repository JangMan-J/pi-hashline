import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Prefer the repo-local install (what `npm ci` provides in CI); fall back to a local
// pi-fork install when browsing the tree without installing dependencies.
let createJiti, piEntry, tuiEntry, typeboxEntry;
try {
	const localRequire = createRequire(import.meta.url);
	createJiti = (await import("jiti")).createJiti;
	piEntry = localRequire.resolve("@earendil-works/pi-coding-agent");
	tuiEntry = localRequire.resolve("@earendil-works/pi-tui");
	typeboxEntry = localRequire.resolve("typebox");
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

// 1. Model-family routing + manual/calibrated precedence in hashline.json
assert.equal(shouldUseHashline({ provider: "antigravity", id: "gemini-4-carbon" }), true);
assert.equal(shouldUseHashline({ provider: "google", id: "gemini-4-argon" }), true);
assert.equal(shouldUseHashline({ provider: "openai-codex", id: "gpt-6-astra" }), true);
assert.equal(shouldUseHashline({ provider: "anthropic", id: "claude-opus-5-5" }), false);
assert.equal(shouldUseHashline({ provider: "kimi-coding", id: "k3.1-pro-highspeed" }), false);

// Calibrated entry overrides default family wildcard, and manual rule overrides calibrated entry
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
assert.equal(shouldUseHashline({ provider: "kimi-coding", id: "k3.1-pro-highspeed" }), true);

customCfg.rules.unshift({ match: "kimi-coding/*", use: "replace", manual: true });
cfgMod.saveConfigSync(customCfg, process.env.PI_CODING_AGENT_DIR);
assert.equal(shouldUseHashline({ provider: "kimi-coding", id: "k3.1-pro-highspeed" }), false);
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
const tuiMod = await jiti.import(tuiEntry);
const { HashlinePickerComponent, GAUGE_ICON, EST_BENCH_HINT, benchHint } = pickerMod;
const { visibleWidth } = tuiMod;

// Verify config.ts also accepts "built-in" in hand-edited JSON rules
assert.equal(
	cfgMod.resolveModelDecision(
		{ version: 1, defaultUse: "built-in", minSpeedup: 1.15, rules: [{ match: "anthropic/*", use: "built-in", manual: true }], calibrated: {} },
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

const calEntry = (use, passHashline = "2/2", speedup = 2.0, apiCalls = 10, totalTokens = 34200, replaceBytes = 4468, hashlineBytes = 879) => ({
	use, speedup, bytesRatio: +(replaceBytes / hashlineBytes).toFixed(2), passReplace: "2/2", passHashline,
	replaceEditMs: 16324, hashlineEditMs: 8161, replaceBytes, hashlineBytes,
	apiCalls, totalTokens,
	thinking: "high", reason: "test", measuredAt: new Date().toISOString(),
});

// Bench hint: average of recorded apiCalls/totalTokens when present; a labelled estimate only when nothing was measured.
const unmeasured = { ...calEntry("replace"), apiCalls: undefined, totalTokens: undefined };
assert.equal(benchHint({ a: calEntry("hashline", "2/2", 2, 9, 40000), b: calEntry("replace", "2/2", 1, 11, 64000), c: unmeasured }), "bench: ~10 calls · ~52k tok (avg of 2)");
for (const cal of [undefined, {}, { c: unmeasured }]) assert.equal(benchHint(cal), EST_BENCH_HINT);
assert.equal(EST_BENCH_HINT, "bench: ~8 calls · ~60k tok (est.)");
const MEASURED_HINT = "bench: ~10 calls · ~35k tok (avg of 3)";

// Overrun policy is OFF by default (never stops/SIGKILLs slow or retrying benchmarks unless configured!)
const calMod = await import(pathToFileURL(path.join(import.meta.dirname, "calibrate.mjs")).href);
assert.equal(cfgMod.loadConfigSync(process.env.PI_CODING_AGENT_DIR).stopOnOverrun, false);
assert.deepEqual(calMod.resolveOverrunPolicy({}, { stopOnOverrun: false }), {
	stopOnOverrun: false,
	maxCalls: 0,
	maxTokens: 0,
	timeoutMs: 0,
});
assert.deepEqual(calMod.resolveOverrunPolicy({}, { stopOnOverrun: true, maxBenchCalls: 30, maxBenchTokens: 150000, benchTimeoutSec: 240 }), {
	stopOnOverrun: true,
	maxCalls: 30,
	maxTokens: 150000,
	timeoutMs: 240000,
});
assert.equal(calMod.median([800, 1200, 50000]), 1200);
assert.equal(calMod.median([1000, 1400]), 1200);
assert.equal(calMod.parseCli(["--repeats", "3", "xai/grok-4.7"]).repeats, 3);

let closed = false;
const runningJobs = new Map();
const benchErrors = new Map();
let pickerCfg = cfgMod.loadConfigSync(process.env.PI_CODING_AGENT_DIR);
pickerCfg.calibrated["antigravity/gemini-4-argon"] = calEntry("hashline", "2/2", 2.0, 10, 34200, 4468, 879); // -80%
pickerCfg.calibrated["anthropic/claude-opus-5-5"] = calEntry("replace", "2/2", 0.95, 11, 36800, 2400, 1080); // -55%
pickerCfg.calibrated["zeta-lab/zeta-1"] = calEntry("replace", "0/2", 0.5);
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
	runningJobs,
	lastBenchErrors: benchErrors,
	now: () => curNow,
	onToggleModel(m, nextUse) {
		const key = `${m.provider}/${m.id}`.toLowerCase();
		pickerCfg.rules = pickerCfg.rules.filter((r) => !(r.manual && r.match.toLowerCase() === key));
		pickerCfg.rules.unshift({ match: key, use: nextUse, manual: true });
		return pickerCfg;
	},
	onResetModel(m) {
		const key = `${m.provider}/${m.id}`.toLowerCase();
		pickerCfg.rules = pickerCfg.rules.filter((r) => !(r.manual && r.match.toLowerCase() === key));
		delete pickerCfg.calibrated[key];
		return pickerCfg;
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

const KEY = { enter: "\r", down: "\x1b[B", tab: "\t", ctrlB: "\x02", ctrlR: "\x12", ctrlX: "\x18", ctrlS: "\x13", ctrlG: "\x07", bksp: "\x7f" };
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
const EDIT_RE = /[●○] (?:hashline|built-in|off)/g;
const RECOMMENDED_RE = new RegExp(`${GAUGE_ICON} [█▓▒░]{6} \\d+\\/\\d+|✗ failed|✓ hashline|✓ built-in|—`);
const selectedRow = (f) => f.slice(...ROWS).find((l) => l.startsWith("▶ "));

/** Header ends/starts and row cell ends must stay 100% invariant across scrolling, toggling, benching, and sorting. */
function geometry(w) {
	const f = render(w);
	const hdr = f[HEADER_ROW];
	const editEnds = new Set();
	const provStarts = new Set();
	const recommendedEnds = new Set();
	const benchEnds = new Set();
	const savedEnds = new Set();
	const provHdr = hdr.indexOf("Provider");
	const provOff = provHdr < 0 ? -1 : xOf(hdr, provHdr);
	const editHdrMatch = /Edit(?: [▲▼])?/.exec(hdr);
	const benchHdrMatch = /Bench(?: [▲▼])?/.exec(hdr);
	const savedHdrMatch = /Saved(?: [▲▼])?/.exec(hdr);
	const recommendedHdrMatch = /Recommended(?: [▲▼])?/.exec(hdr);
	const editEnd = editHdrMatch ? xOf(hdr, editHdrMatch.index + editHdrMatch[0].length) : -1;
	const benchEnd = benchHdrMatch ? xOf(hdr, benchHdrMatch.index + benchHdrMatch[0].length) : -1;
	const savedEnd = savedHdrMatch ? xOf(hdr, savedHdrMatch.index + savedHdrMatch[0].length) : -1;
	const recommendedEnd = recommendedHdrMatch ? xOf(hdr, recommendedHdrMatch.index + recommendedHdrMatch[0].length) : -1;

	for (const row of f.slice(...ROWS)) {
		if (!row.trim()) continue;
		const m = [...row.matchAll(EDIT_RE)].pop();
		assert.ok(m, `row without edit cell: "${row}"`);
		editEnds.add(xOf(row, m.index + m[0].length));
		if (provOff >= 0) provStarts.add(xOf(row, row.search(/\[[A-Z]/)));
		const sp = /\d+\.\d{2}×/.exec(row);
		if (sp) benchEnds.add(xOf(row, sp.index + sp[0].length));
		const sv = /[+-]\d+%/.exec(row);
		if (sv) savedEnds.add(xOf(row, sv.index + sv[0].length));
		const b = RECOMMENDED_RE.exec(row);
		assert.ok(b, `row without recommended cell: "${row}"`);
		recommendedEnds.add(xOf(row, b.index + b[0].length));
	}
	assert.deepEqual([...editEnds], [editEnd], `edit cells misaligned with header at ${w}:\n${f.join("\n")}`);
	if (provOff >= 0) assert.deepEqual([...provStarts], [provOff], `provider cells misaligned at ${w}:\n${f.join("\n")}`);
	if (benchEnds.size > 0 && benchEnd >= 0) assert.deepEqual([...benchEnds], [benchEnd], `bench cells misaligned at ${w}:\n${f.join("\n")}`);
	if (savedEnds.size > 0 && savedEnd >= 0) assert.deepEqual([...savedEnds], [savedEnd], `saved cells misaligned at ${w}:\n${f.join("\n")}`);
	assert.deepEqual([...recommendedEnds], [w], `recommended cells not right-anchored at ${w}`);
	assert.equal(recommendedEnd, w, `recommended header not right-anchored at ${w}: "${hdr}"`);
	return JSON.stringify({ modelOff: xOf(hdr, hdr.indexOf("Model")), provOff, benchEnd, savedEnd, editEnd, recommendedEnd, height: f.length });
}

// Initial: Frequent tab, accent headers, right-aligned token/API-call transparency hint on bottom bar.
let f120 = render(120);
const emptySearchLine = f120[5];
assert.ok(emptySearchLine.startsWith("  Search: "));
assert.ok(selectedRow(f120).startsWith("▶ Claude Opus 5.5 ●"), f120.join("\n"));
assert.ok(f120[17].includes("anthropic/claude-opus-5-5 · benchmarked → built-in · payload 1.1KB vs 2.3KB (11 calls · 36.8k tok)"), f120[17]);
// Bottom bar has key hints on the left and right-justified estimated API calls / token usage on the right!
assert.ok(f120.at(-2).startsWith("  Enter swap · Ctrl+R reset · Ctrl+S sort · Ctrl+B bench"), f120.at(-2));
assert.ok(f120.at(-2).endsWith(`${MEASURED_HINT}  `), `bottom bar not right-justified: "${f120.at(-2)}"`);

// Every column header is accent-colored (differentiated from data rows), even when unsorted!
const styledHdrInitial = render(120, markTheme)[HEADER_ROW];
for (const h of ["Model", "Provider", "Bench", "Saved", "Edit", "Recommended"]) {
	assert.ok(styledHdrInitial.includes(`\x1b[35m${h}\x1b[39m`), `header ${h} missing accent color: ${styledHdrInitial}`);
}

// Bench + Saved columns: show measured ratio & byte savings ONLY for benchmarked models (2.00× / -80%, 0.95× / -55%), blank for unbenched!
const astraRow = f120.find((l) => l.includes("GPT-6 Astra"));
assert.ok(astraRow && !/\d+\.\d{2}×/.test(astraRow) && !/[+-]\d+%/.test(astraRow) && astraRow.trimEnd().endsWith("—"), `unbenched row should have blank Bench/Saved: "${astraRow}"`);
assert.ok(f120.some((l) => l.includes("Gemini 4 Argon ★ ●") && l.includes("2.00×") && l.includes("-80%") && l.includes("● hashline") && l.includes("✓ hashline")));
assert.ok(f120.some((l) => l.includes("Claude Opus 5.5 ●") && l.includes("0.95×") && l.includes("-55%") && l.includes("○ built-in") && l.includes("✓ built-in")));

// 0-jitter: header and cell x-offsets identical across scrolling, Enter toggles, Ctrl+R reset, live gauge ticks, and every Ctrl+S mode.
for (const w of [120, 92]) {
	const base = geometry(w);
	const seen = new Set();
	for (let i = 0; i < 16; i++) {
		picker.handleInput(KEY.down);
		seen.add(selectedRow(render(w)));
		assert.equal(geometry(w), base, `scroll jitter at ${w}`);
	}
	assert.ok(seen.size >= 15, "scrolled through every Frequent row");
	for (const k of [KEY.enter, KEY.enter, KEY.ctrlR, KEY.ctrlB, KEY.ctrlB]) {
		picker.handleInput(k);
		assert.equal(geometry(w), base, `jitter after key ${JSON.stringify(k)} at ${w}`);
	}
	for (let i = 0; i < 13; i++) {
		picker.handleInput(KEY.ctrlS);
		assert.equal(geometry(w), base, `sort jitter at ${w} step ${i}`);
	}
	assert.equal(picker.sortMode, "default");
}

// Enter toggles manual override; Ctrl+R (and Ctrl+X) resets both manual override AND benchmark result!
for (let i = 0; i < 20 && !selectedRow(render(120)).includes("Claude Opus 5.5"); i++) picker.handleInput(KEY.down);
picker.handleInput(KEY.enter);
f120 = render(120);
assert.ok(selectedRow(f120).includes("Claude Opus 5.5 ●") && selectedRow(f120).includes("● hashline"), f120.join("\n"));
assert.ok(f120[17].includes("manual → hashline"), f120[17]);
picker.handleInput(KEY.ctrlR);
f120 = render(120);
assert.ok(
	selectedRow(f120).includes("○ built-in") &&
		selectedRow(f120).trimEnd().endsWith("—") &&
		!/\d+\.\d{2}×/.test(selectedRow(f120)) &&
		f120[17].includes("rule (anthropic) → built-in"),
	`Ctrl+R must clear both manual override and benchmark: ${selectedRow(f120)} | ${f120[17]}`,
);
// Restore Argon + Claude calibration for the remaining sort assertions
pickerCfg.calibrated["antigravity/gemini-4-argon"] = calEntry("hashline", "2/2", 2.0, 10, 34200, 4468, 879);
pickerCfg.calibrated["anthropic/claude-opus-5-5"] = calEntry("replace", "2/2", 0.95, 11, 36800, 2400, 1080);
picker.syncState({ config: pickerCfg });

picker.handleInput(KEY.ctrlB);
f120 = render(120);
assert.ok(selectedRow(f120).includes(`${GAUGE_ICON} ▒░░░░░ 0/8`), selectedRow(f120));
assert.ok(f120.at(-2).endsWith(`${GAUGE_ICON} 0/~8 calls · ~60k tok est  `), f120.at(-2));
// Simulate live streaming progress from calibrate.mjs (`4/8` steps, 4 API calls, 24.2k tokens), plus overrun beyond estimate without stopping!
const runningClaude = runningJobs.get("anthropic/claude-opus-5-5");
runningClaude.doneSteps = 4;
runningClaude.apiCalls = 4;
runningClaude.totalTokens = 24200;
curNow += 500;
f120 = render(120);
assert.ok(selectedRow(f120).includes(`${GAUGE_ICON} ███░░░ 4/8`), selectedRow(f120));
assert.ok(f120.at(-2).endsWith(`${GAUGE_ICON} 4/~8 calls · 24.2k/~60k tok  `), f120.at(-2));
runningClaude.apiCalls = 11;
runningClaude.totalTokens = 74000;
assert.ok(render(120).at(-2).endsWith(`${GAUGE_ICON} 11/~8 calls · 74k/~60k tok  `), "keeps running smoothly past estimate");
runningClaude.doneSteps = 8;
assert.ok(selectedRow(render(120)).includes(`${GAUGE_ICON} ██████ 8/8`));
picker.handleInput(KEY.ctrlB);

// Ctrl+S cycles every visible column ▲ then ▼ left-to-right with zero no-op presses, accurate arrows, and anchored selection.
const EXPECTED_HDR = {
	"model-asc": ["Model", "▲"],
	"model-desc": ["Model", "▼"],
	"provider-asc": ["Provider", "▲"],
	"provider-desc": ["Provider", "▼"],
	"bench-asc": ["Bench", "▲"],
	"bench-desc": ["Bench", "▼"],
	"saved-asc": ["Saved", "▲"],
	"saved-desc": ["Saved", "▼"],
	"edit-asc": ["Edit", "▲"],
	"edit-desc": ["Edit", "▼"],
	"recommended-asc": ["Recommended", "▲"],
	"recommended-desc": ["Recommended", "▼"],
};
const anchor = selectedRow(render(120)).slice(0, 20);
const modes = [];
let prevHdr = render(120, markTheme)[HEADER_ROW];
for (let i = 0; i < 13; i++) {
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
	if (picker.sortMode === "bench-desc") {
		const argonIdx = rows.findIndex((l) => l.includes("2.00×"));
		const claudeIdx = rows.findIndex((l) => l.includes("0.95×"));
		const firstBlankIdx = rows.findIndex((l) => !/\d+\.\d{2}×/.test(l));
		assert.ok(argonIdx === 0 && claudeIdx === 1 && firstBlankIdx === 2, rows.join("\n"));
	}
	if (picker.sortMode === "bench-asc") {
		const claudeIdx = rows.findIndex((l) => l.includes("0.95×"));
		const argonIdx = rows.findIndex((l) => l.includes("2.00×"));
		const firstBlankIdx = rows.findIndex((l) => !/\d+\.\d{2}×/.test(l));
		assert.ok(claudeIdx === 0 && argonIdx === 1 && firstBlankIdx === 2, rows.join("\n"));
	}
	if (picker.sortMode === "saved-desc") {
		const argonIdx = rows.findIndex((l) => l.includes("-80%"));
		const claudeIdx = rows.findIndex((l) => l.includes("-55%"));
		const firstBlankIdx = rows.findIndex((l) => !/[+-]\d+%/.test(l));
		assert.ok(argonIdx === 0 && claudeIdx === 1 && firstBlankIdx === 2, rows.join("\n"));
	}
	if (picker.sortMode === "saved-asc") {
		const claudeIdx = rows.findIndex((l) => l.includes("-55%"));
		const argonIdx = rows.findIndex((l) => l.includes("-80%"));
		const firstBlankIdx = rows.findIndex((l) => !/[+-]\d+%/.test(l));
		assert.ok(claudeIdx === 0 && argonIdx === 1 && firstBlankIdx === 2, rows.join("\n"));
	}
	if (picker.sortMode === "recommended-desc") {
		const rank = (l) => ["✓ hashline", "✓ built-in", "✗ failed", "—"].findIndex((s) => l.includes(s));
		assert.ok(rows.every((l, j) => j === 0 || rank(rows[j - 1]) <= rank(l)), rows.join("\n"));
	}
	if (picker.sortMode === "recommended-asc") {
		const rank = (l) => ["✗ failed", "✓ built-in", "✓ hashline", "—"].findIndex((s) => l.includes(s));
		assert.ok(rows.every((l, j) => j === 0 || rank(rows[j - 1]) <= rank(l)), rows.join("\n"));
	}
	if (picker.sortMode === "edit-desc") {
		const hl = rows.map((l) => /[●○] hashline/.test(l));
		assert.ok(hl.every((v, j) => j === 0 || hl[j - 1] >= v), rows.join("\n"));
	}
	if (picker.sortMode === "edit-asc") {
		const hl = rows.map((l) => /[●○] hashline/.test(l));
		assert.ok(hl.every((v, j) => j === 0 || hl[j - 1] <= v), rows.join("\n"));
	}
}
assert.deepEqual(modes, [
	"model-asc", "model-desc", "provider-asc", "provider-desc",
	"bench-asc", "bench-desc", "saved-asc", "saved-desc", "edit-asc", "edit-desc", "recommended-asc", "recommended-desc", "default",
]);

// Switch to Bench ▼, then test Search query: fuzzy rank governs while typing (arrows hidden), Ctrl+S during search sorts matches with arrow, and clearing restores prior sort when untouched.
for (let i = 0; i < 6; i++) picker.handleInput(KEY.ctrlS);
assert.equal(picker.sortMode, "bench-desc");
for (const ch of "arg") picker.handleInput(ch);
f120 = render(120);
assert.ok(selectedRow(f120).startsWith("▶ Gemini 4 Argon ★ ●"), f120.join("\n"));
assert.ok(!/[▲▼]/.test(f120[HEADER_ROW]) && f120[HEADER_ROW].includes("Bench"), f120[HEADER_ROW]);
for (let i = 0; i < 3; i++) picker.handleInput(KEY.bksp);
assert.ok(render(120)[HEADER_ROW].includes("Bench ▼"));
// Search + Ctrl+S sorts filtered rows and shows column arrow!
for (const ch of "zeta") picker.handleInput(ch);
assert.ok(!/[▲▼]/.test(render(120)[HEADER_ROW]));
picker.handleInput(KEY.ctrlS);
assert.equal(picker.sortMode, "model-asc");
assert.ok(render(120)[HEADER_ROW].includes("Model ▲"));
picker.handleInput(KEY.ctrlS);
assert.equal(picker.sortMode, "model-desc");
assert.ok(render(120)[HEADER_ROW].includes("Model ▼"));
for (let i = 0; i < 4; i++) picker.handleInput(KEY.bksp);
// Reset sortMode back to default on Frequent
while (picker.sortMode !== "default") picker.handleInput(KEY.ctrlS);
assert.equal(picker.sortMode, "default");

// Benchmarked and All tabs have zero dead Ctrl+S presses (no duplicate default vs bench-desc / model-asc)!
picker.handleInput(KEY.tab); // -> Benchmarked
assert.equal(picker.sortMode, "bench-desc");
assert.ok(render(120)[HEADER_ROW].includes("Bench ▼"));
picker.handleInput(KEY.ctrlS);
assert.equal(picker.sortMode, "saved-asc");
while (picker.sortMode !== "bench-desc") picker.handleInput(KEY.ctrlS);
picker.handleInput(KEY.tab); // -> All
picker.syncState({}); // keep state, verify All default after resetting to default via Frequent
for (let i = 0; i < 6; i++) picker.handleInput(KEY.tab); // back to Frequent (8 tabs total: Frequent, Benchmarked, All + 5 providers)
assert.ok(render(120)[3].includes("Frequent"));
while (picker.sortMode !== "default") picker.handleInput(KEY.ctrlS);
picker.handleInput(KEY.tab); // Benchmarked in default -> Bench ▼, first Ctrl+S -> Edit ▲
assert.equal(picker.sortMode, "bench-desc");
picker.handleInput(KEY.tab); // All in default -> Model ▲, first Ctrl+S -> Model ▼
assert.equal(picker.sortMode, "model-asc");
picker.handleInput(KEY.ctrlS);
assert.equal(picker.sortMode, "model-desc");
for (let i = 0; i < 6; i++) picker.handleInput(KEY.tab); // back to Frequent
while (picker.sortMode !== "default") picker.handleInput(KEY.ctrlS);

// Ctrl+G (Zellij unlock) is ignored and never reaches Search; header shows benchmark count without any "mode:" concept.
assert.ok(!render(120)[1].includes("mode:"), render(120)[1]);
assert.ok(render(120)[1].includes("3 benchmarked"), render(120)[1]);
picker.handleInput(KEY.ctrlG);
f120 = render(120);
assert.equal(f120[5], emptySearchLine, "Ctrl+G must not reach Search");

// Widths 42/68/92/120 on every tab: header and cells drop in lockstep (bench -> recommended -> edit).
for (let t = 0; t < 8; t++) {
	for (const w of [42, 68, 92, 120]) {
		const f = render(w);
		const hdr = f[HEADER_ROW];
		const rows = f.slice(...ROWS).filter((l) => l.trim() && !l.includes("No "));
		assert.equal(hdr.includes("Recommended"), rows.some((l) => RECOMMENDED_RE.test(l)), `recommended lockstep tab ${t} w ${w}`);
		assert.equal(hdr.includes("Edit"), rows.some((l) => /[●○] (?:hashline|built-in|off)/.test(l)) || !rows.length, `edit lockstep tab ${t} w ${w}`);
		if (w === 42) assert.ok(hdr.includes("Edit") && !hdr.includes("Bench") && !hdr.includes("Saved") && (!hdr.includes("Provider") || !hdr.includes("Recommended")), hdr);
		if (w >= 92) assert.ok(hdr.includes("Bench") && hdr.includes("Saved") && hdr.includes("Recommended"), hdr);
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
assert.equal(picker.sortMode, "model-asc");
for (let i = 0; i < 10; i++) {
	picker.handleInput(KEY.ctrlS);
	zetaModes.push(picker.sortMode);
	assert.equal(geometry(120), zetaBase);
}
assert.deepEqual(zetaModes, ["model-desc", "bench-asc", "bench-desc", "saved-asc", "saved-desc", "edit-asc", "edit-desc", "recommended-asc", "recommended-desc", "model-asc"]);
// Narrow widths on Zeta Lab: w=42 drops Bench (leaving Model, Edit, Recommended); w=40 drops Recommended too (leaving Model, Edit)!
render(42);
const midNarrowModes = [];
for (let i = 0; i < 6; i++) {
	picker.handleInput(KEY.ctrlS);
	midNarrowModes.push(picker.sortMode);
}
assert.deepEqual(midNarrowModes, ["model-desc", "edit-asc", "edit-desc", "recommended-asc", "recommended-desc", "model-asc"]);
render(40);
const narrowModes = [];
for (let i = 0; i < 4; i++) {
	picker.handleInput(KEY.ctrlS);
	narrowModes.push(picker.sortMode);
}
assert.deepEqual(narrowModes, ["model-desc", "edit-asc", "edit-desc", "model-asc"]);

// Provider tab with out-of-order currentModel puts currentModel first with NO deceptive Model ▲ arrow until Ctrl+S!
render(120);
picker.syncState({
	allModels: [...catalog, { provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" }],
});
// Advance 1 Tab from Zeta Lab -> Frequent, reset sort to default, then Tab to Anthropic (index 3)
picker.handleInput(KEY.tab); // -> Frequent
for (let i = 0; i < 15 && picker.sortMode !== "default"; i++) picker.handleInput(KEY.ctrlS);
assert.equal(picker.sortMode, "default");
picker.handleInput(KEY.tab); // Benchmarked
picker.handleInput(KEY.tab); // All
picker.handleInput(KEY.tab); // Anthropic (currentModel Claude Opus 5.5 > Claude Haiku 4.5 alphabetically!)
const anthDefault = render(120);
assert.equal(picker.sortMode, "default");
assert.ok(!/[▲▼]/.test(anthDefault[HEADER_ROW]), `expected no arrow when currentModel is first: ${anthDefault[HEADER_ROW]}`);
const anthRowsDefault = anthDefault.slice(...ROWS).filter((l) => l.trim());
assert.ok(anthRowsDefault[0].includes("Claude Opus 5.5") && anthRowsDefault[1].includes("Claude Haiku 4.5"), anthRowsDefault.join("\n"));
picker.handleInput(KEY.ctrlS);
const anthAsc = render(120);
assert.equal(picker.sortMode, "model-asc");
assert.ok(anthAsc[HEADER_ROW].includes("Model ▲"), anthAsc[HEADER_ROW]);
const anthRowsAsc = anthAsc.slice(...ROWS).filter((l) => l.trim());
assert.ok(anthRowsAsc[0].includes("Claude Haiku 4.5") && anthRowsAsc[1].includes("Claude Opus 5.5"), anthRowsAsc.join("\n"));

// Never render the counter-intuitive word "replace" or "Uses" anywhere in the UI!
const everything = allFrames.flat().join("\n");
for (const bad of ["replace", "Uses", "untested", "⟳ running", "Speed", "pinned", "unpin"]) {
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

// 9. Regression test: start benchmark in Menu #1 -> Esc close -> reopen Menu #2 -> benchmark finishes while Menu #2 is open -> Bench & Recommended columns update immediately!
const { EventEmitter } = await import("node:events");
const { openHashlineMenu } = pickerMod;
const liveJobs = new Map();
const liveErrors = new Map();
let fakeChild;
const fakeSpawn = () => {
	fakeChild = Object.assign(new EventEmitter(), {
		pid: 999999,
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
		kill() {},
	});
	return fakeChild;
};
const makeMenuCtx = (onMount) => ({
	model: catalog[0], // GPT-6 Astra (unbenchmarked!)
	modelRegistry: { refresh: () => Promise.resolve(), getAvailable: () => catalog },
	ui: {
		notify() {},
		custom: (fn) =>
			new Promise((resolve) => {
				let renders = 0;
				const tui = { requestRender() { renders++; } };
				const comp = fn(tui, plainTheme, null, resolve);
				onMount({ comp, getRenders: () => renders });
			}),
	},
});

let m1;
const p1 = openHashlineMenu({
	ctx: makeMenuCtx((x) => (m1 = x)),
	runningJobs: liveJobs,
	lastBenchErrors: liveErrors,
	spawnBench: fakeSpawn,
});
m1.comp.handleInput(KEY.ctrlB); // Start benchmark on GPT-6 Astra in Menu #1
fakeChild.stdout.emit("data", '[PROGRESS] {"done":4,"total":8,"calls":6,"tokens":28000}\n');
assert.match(selectedRow(m1.comp.render(120)), new RegExp(`${GAUGE_ICON} ███[▒░]░░ 4\\/8`));
m1.comp.handleInput("\x1b"); // Close Menu #1 while benchmark is still running!
await p1;

let m2;
const p2 = openHashlineMenu({
	ctx: makeMenuCtx((x) => (m2 = x)),
	runningJobs: liveJobs,
	lastBenchErrors: liveErrors,
	spawnBench: fakeSpawn,
});
// Menu #2 sees the continuing benchmark at 4/8
assert.match(selectedRow(m2.comp.render(120)), new RegExp(`${GAUGE_ICON} ███[▒░]░░ 4\\/8`));
const rendersBeforeFinish = m2.getRenders();
// Benchmark writes result to hashline.json and exits while Menu #2 is open!
const diskCfg = cfgMod.loadConfigSync(process.env.PI_CODING_AGENT_DIR);
diskCfg.calibrated["openai-codex/gpt-6-astra"] = calEntry("hashline", "2/2", 1.72, 14, 58400);
cfgMod.saveConfigSync(diskCfg, process.env.PI_CODING_AGENT_DIR);
fakeChild.emit("close", 0);

assert.ok(m2.getRenders() > rendersBeforeFinish, "Menu #2 must re-render when background benchmark finishes");
const afterFinishRow = selectedRow(m2.comp.render(120));
assert.ok(afterFinishRow.includes("1.72×") && afterFinishRow.includes("✓ hashline"), `Menu #2 missing Bench/Recommended after finish: "${afterFinishRow}"`);
// Pressing Ctrl+R inside real openHashlineMenu clears the benchmarked entry + manual overrides on disk AND triggers requestRender()!
const rendersBeforeReset = m2.getRenders();
m2.comp.handleInput(KEY.ctrlR);
assert.ok(m2.getRenders() > rendersBeforeReset, "Ctrl+R must requestRender");
const afterResetRow = selectedRow(m2.comp.render(120));
assert.ok(!afterResetRow.includes("1.72×") && afterResetRow.trimEnd().endsWith("—"), `Ctrl+R did not clear Bench/Recommended: "${afterResetRow}"`);
assert.equal(cfgMod.loadConfigSync(process.env.PI_CODING_AGENT_DIR, false, true).calibrated["openai-codex/gpt-6-astra"], undefined);
m2.comp.handleInput("\x1b");
await p2;
fs.rmSync(tmp, { recursive: true, force: true });
console.log("ALL_PI_HASHLINE_TESTS_PASSED");
