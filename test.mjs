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

fs.rmSync(tmp, { recursive: true, force: true });
console.log("ALL_PI_HASHLINE_TESTS_PASSED");
