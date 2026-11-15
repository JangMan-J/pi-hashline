#!/usr/bin/env node
/**
 * Stage 0 of ~/Projects/PLAN-2026-11-15-edit-tests.md: counts from recorded Pi sessions, no model calls.
 *
 *   node scripts/edit-counts.ts [--out counts.json] [--skip-names names.txt] <sessions dir>...
 *
 * Every counter is additive, so the outputs of two machines are merged by summing them. Counts are kept per
 * model (the physical model that wrote the response a tool call came from) under `models`, and summed in `total`.
 * Calls made through codemode carry no result text and are not counted here.
 *
 * What each group of counters answers is in the plan; the names are spelled out at `COUNTERS` below.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

export const COUNTS_VERSION = 5;

/** counter -> what it counts */
export const COUNTERS: Record<string, string> = {
	responses: "assistant responses",
	spend: "recorded cost of those responses, USD",
	outputTokens: "output tokens, thinking included",
	costOutput: "recorded cost of output tokens, USD",
	reasoningTokens: "thinking tokens, from responses whose provider reports them",
	reasoningResponses: "responses whose provider reports thinking tokens",
	visibleBytes: "bytes of visible output (text and tool-call arguments)",
	plainBytes: "visible bytes of responses with no thinking",
	plainTokens: "output tokens of responses with no thinking (plainBytes / plainTokens = bytes per token)",

	editCalls: "built-in edit calls with a result",
	editOk: "of those, successful",
	editFailed: "of those, failed",
	failNotFound: "failed: old text not found",
	failNotUnique: "failed: old text occurs more than once",
	failNoChange: "failed: the replacement left the file identical",
	failFileError: "failed: the file could not be read or written",
	failBlocked: "refused by something other than the edit tool (a supervising extension, a budget, a permission); not an edit failure",

	// candidate 1, the cascade
	nfRetried: "not-found failures followed by a successful edit of the same file carrying the same new text",
	nfRetriedLoose: "not-found failures followed, within 3 responses, by some successful edit of the same file (new text differs)",
	nfNoRetry: "not-found failures with neither",
	nfCascadeResponses: "responses from the failure to the retry, inclusive of the retry (over nfRetried + nfRetriedLoose)",
	nfCascadeSpend: "their recorded cost, USD",
	nfCascadeMs: "their recorded duration, ms",
	nfRereadBeforeRetry: "retried not-found failures where the file was read again before the retry",
	nuRetried: "not-unique failures followed by a successful edit of the same file within 3 responses",
	nuCascadeResponses: "responses from that failure to the retry",
	nuCascadeSpend: "their recorded cost, USD",
	// candidate 1, why the old text missed (failed old text against the retry's old text; nfRetried only)
	nfIndentOnly: "same lines once leading and trailing whitespace is stripped",
	nfWhitespaceOnly: "same text once all whitespace is removed, but not indent-only",
	nfOverlapHigh: "content differs; at least 80% of lines in common",
	nfOverlapMid: "content differs; 50% to 80% of lines in common",
	nfOverlapLow: "content differs; under 50% of lines in common",
	// candidate 1, with the file as it was (only where the session holds the whole file)
	nfFileKnown: "not-found failures where the session holds the whole file at that moment",
	nfIndentUnique: "of nfFileKnown: an indent-normalized match exists and is unique",
	nfIndentAmbiguous: "of nfFileKnown: an indent-normalized match exists more than once",
	nfIndentNone: "of nfFileKnown: no indent-normalized match",
	nfRescueRight: "unique indent-normalized match lands where the retry landed",
	nfRescueWrong: "unique indent-normalized match lands somewhere else",
	nfRescueUnchecked: "unique indent-normalized match, but no retry to check it against",
	nfNearestRight: "closest window of lines (by lines in common) is where the retry landed",
	nfNearestWrong: "closest window is somewhere else",
	// candidate 3, drift
	nfAfterFormatter: "not-found failures where a formatter ran in the shell since the file was last read or edited",
	nfAfterShell: "not-found failures where any shell command ran since the file was last read or edited",
	nfFileNeverSeen: "not-found failures on a file the session had not read, written or edited before",

	// candidate 2a
	ops: "replacements in successful edits (one call can carry several)",
	oldBytes: "bytes of old text quoted in those",
	newBytes: "bytes of new text in those",
	ops1: "replacements whose old text is 1 line",
	ops2: "replacements whose old text is 2 lines",
	ops3: "replacements whose old text is 3 or more lines",
	oldBytes3: "old-text bytes of the 3-or-more-line replacements",
	anchorSavedBytes: "of oldBytes3, the bytes not in the first or last line (what quoting only those two saves)",
	opsFileKnown: "replacements where the session holds the whole file and the old text is found exactly once",
	ops3FileKnown: "of those, with 3 or more lines of old text",
	anchorOk: "of ops3FileKnown: the first line occurs once in the file and the next occurrence of the last line after it is the block's end",
	anchorFirstAmbiguous: "of ops3FileKnown: the first line occurs more than once",
	anchorLastEarly: "of ops3FileKnown: the last line also occurs inside the block, so the splice would stop short",
	// candidate 2b
	stopLength: "responses that ended on the output limit",
	stopLengthInEdit: "of those, ending inside an edit or write call",

	// candidate 3
	syntaxLoops: "a successful edit, then within 2 responses a shell result with a syntax error naming the file, then another edit of it within 2 more",
	syntaxLoopResponses: "responses from the first edit to the second",
	syntaxLoopSpend: "their recorded cost, USD",

	// candidate 4 (a run is everything between two user messages)
	runs: "runs",
	runsWithEdit: "runs containing an edit, write or hashline_edit call",
	spendToFirstEdit: "cost of responses up to and including the first such call, in those runs, USD",
	spendAfterFirstEdit: "cost of the responses after it, USD",
	responsesAfterFirstEdit: "responses after it",
	reasoningToFirstEdit: "thinking tokens up to and including it (reporting providers only)",
	reasoningAfterFirstEdit: "thinking tokens after it (reporting providers only)",
	outputAfterFirstEdit: "output tokens after it",
	costOutputAfterFirstEdit: "recorded cost of output tokens after it, USD",
	contextAtFirstEdit: "prompt size (input + cache read + cache write) of the response making the first edit, summed over runsWithEdit",

	// candidate 5
	repeatGroups: "groups of 3 or more replacements in one run with identical old and new text",
	repeatOps: "replacements in those groups",
	partialReadGroups: "files read in 3 or more pieces (offset or limit) within one run",
	partialReads: "read calls in those groups",
	partialReadTurns: "responses those reads were spread over, less one per group (the turns one symbol read would save at most)",

	// one program instead of many turns (code mode)
	toolResponses: "responses that call at least one tool",
	multiCallResponses: "of those, calling two or more tools at once",
	toolCalls: "tool calls made directly by the model",
	codemodeCalls: "of those, codemode calls",
	nestedCalls: "tool calls made from inside codemode scripts",
	lookupChains: "runs of 2 or more consecutive responses that only call read, grep, find or ls",
	lookupChainExtra: "responses in those chains beyond the first of each (what one program could fold away at most)",
	lookupChainExtraSpend: "their recorded cost, USD",
	shellChains: "the same, also allowing bash",
	shellChainExtra: "responses in those chains beyond the first of each",
	shellChainExtraSpend: "their recorded cost, USD",

	// candidate 6
	reeditNoRead: "successful edits of a file whose previous event in the session was an edit from an earlier response, with no read between",
	reeditSameResponse: "successful edits of a file already edited by another call in the same response",

	fileStale: "times the reconstructed file disagreed with a successful edit and was dropped",
};

/**
 * What the prompt is made of. Everything that enters the conversation is re-read by every later response until a
 * compaction drops it, so each kind of content has a size (`rentBytes_*`) and a rent (`rentTurns_*`: its bytes
 * times the later responses that re-read them).
 */
const RENT_KINDS: Record<string, string> = {
	user: "what the user typed",
	injected: "messages other extensions put into the conversation",
	summary: "compaction summaries",
	assistantText: "the model's visible text",
	callEdit: "arguments of edit, write and hashline_edit calls (the new text, and any old text quoted)",
	callCodemode: "codemode scripts",
	callOther: "arguments of every other tool call",
	resultRead: "results of read",
	resultShell: "results of bash",
	resultEdit: "results of edit, write and hashline_edit",
	resultLookup: "results of grep, find and ls",
	resultCodemode: "results of codemode",
	resultOther: "results of every other tool",
};
for (const [kind, what] of Object.entries(RENT_KINDS)) {
	COUNTERS[`rentBytes_${kind}`] = `bytes entering the prompt: ${what}`;
	COUNTERS[`rentTurns_${kind}`] = `those bytes times the later responses that re-read them: ${what}`;
}
Object.assign(COUNTERS, {
	sessions: "session files with at least one response",
	baseTokens: "prompt size of each session's first response (system prompt, tool list and the first message), tokens, summed",
	baseTokenTurns: "that size times the session's responses: what re-reading the fixed part of the prompt adds up to",
	promptTokenTurns: "prompt tokens read by all responses (input + cache read + cache write)",
	supersededReadTurns: "rent of read results after the same file was read again or edited, byte-turns",
	longShellTurns: "rent of bash results over 8 KB, byte-turns",
	longReadTurns: "rent of read results over 16 KB, byte-turns",
});

/** Responses and their cost by how large the prompt was when they were written. */
const PROMPT_BUCKETS: [name: string, below: number][] = [["under50k", 50_000], ["50to100k", 100_000], ["100to200k", 200_000], ["200to400k", 400_000], ["over400k", Number.POSITIVE_INFINITY]];
for (const [name] of PROMPT_BUCKETS) {
	COUNTERS[`promptResponses_${name}`] = `responses written with a prompt of this size (tokens): ${name}`;
	COUNTERS[`promptSpend_${name}`] = `their recorded cost, USD: ${name}`;
}

type Counts = Record<string, number>;
const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
const linesOf = (text: string): string[] => text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
const trimmed = (text: string): string[] => linesOf(text).map((l) => l.trim());
const FORMATTER = /\b(prettier|biome\s+(format|check)|eslint\b.*--fix|ruff\s+format|black\s|cargo\s+fmt|rustfmt|gofmt|go\s+fmt|clang-format|npm\s+run\s+(format|fmt|lint:fix|fix)|dprint|shfmt|stylua)\b/;
const SYNTAX_ERROR = /SyntaxError|syntax error|ParseError|Parse error|Unexpected token|IndentationError|unexpected (indent|EOF|end of)|error TS1\d{3}|expected one of|unterminated|unclosed delimiter/i;
const TRUNCATED_READ = /\[(\d+ more lines in file|Showing lines|Read truncated)[^\]]*\]\s*$/;
const HASHLINE_HEADER = /^\[[^\]\n]+#[0-9A-Fa-f]{3,6}\]\n/;
const EDITING = new Set(["edit", "write", "hashline_edit"]);
const LOOKUP = new Set(["read", "grep", "find", "ls"]);

type Failure = "notFound" | "notUnique" | "noChange" | "fileError" | "blocked";
function failureKind(text: string): Failure {
	if (/^Could not find /.test(text)) return "notFound";
	if (/^Found \d+ occurrences/.test(text)) return "notUnique";
	if (/^No changes made to /.test(text)) return "noChange";
	if (/^Could not edit file|^File not found|ENOENT|EACCES|EISDIR/.test(text)) return "fileError";
	// Anything else did not come from the edit tool: a supervising extension or a budget refused the call.
	return "blocked";
}
const FAILURE_COUNTER: Record<Failure, string> = { notFound: "failNotFound", notUnique: "failNotUnique", noChange: "failNoChange", fileError: "failFileError", blocked: "failBlocked" };

interface Op {
	old: string;
	new: string;
}
function opsOf(args: any): Op[] {
	const list = Array.isArray(args?.edits) ? args.edits : args && typeof args.oldText === "string" ? [args] : [];
	return list
		.filter((e: any) => typeof e?.oldText === "string" && typeof e?.newText === "string")
		.map((e: any) => ({ old: e.oldText, new: e.newText }));
}

/** Start line of every place the trimmed lines of `needle` occur as a run in `hay` (already trimmed). */
function findLineRuns(hay: string[], needle: string[], limit = 3): number[] {
	const out: number[] = [];
	if (needle.length === 0 || needle.length > hay.length) return out;
	for (let i = 0; i + needle.length <= hay.length && out.length < limit; i++) {
		let j = 0;
		while (j < needle.length && hay[i + j] === needle[j]) j++;
		if (j === needle.length) out.push(i);
	}
	return out;
}

/** Start line of the window of `needle.length` lines sharing the most lines with `needle`; -1 when nothing is shared. */
function nearestWindow(hay: string[], needle: string[]): number {
	if (needle.length === 0 || hay.length === 0 || hay.length > 20000 || needle.length > 400) return -1;
	const want = new Set(needle.filter((l) => l.length > 0));
	const hit = hay.map((l) => (want.has(l) ? 1 : 0));
	const span = Math.min(needle.length, hay.length);
	let sum = 0;
	for (let i = 0; i < span; i++) sum += hit[i];
	let best = sum;
	let at = 0;
	for (let i = span; i < hay.length; i++) {
		sum += hit[i] - hit[i - span];
		if (sum > best) {
			best = sum;
			at = i - span + 1;
		}
	}
	return best > 0 ? at : -1;
}

/** Line index where `text` starts in `file`, when it occurs exactly once; -1 otherwise. */
function uniqueLineOf(file: string, text: string): number {
	const at = file.indexOf(text);
	if (at < 0 || file.indexOf(text, at + 1) >= 0) return -1;
	let line = 0;
	for (let i = file.indexOf("\n"); i >= 0 && i < at; i = file.indexOf("\n", i + 1)) line++;
	return line;
}

interface Response {
	model: string;
	cost: number;
	output: number;
	reasoning: number | undefined;
	context: number;
	ms: number;
	run: number;
}
interface EditRecord {
	resp: number;
	model: string;
	file: string;
	ok: boolean;
	kind: Failure | "ok";
	ops: Op[];
	failedOp: number;
	/** The whole file as the session knew it when a not-found failure happened. */
	fileThen?: string;
}

export async function countFile(file: string, models: Record<string, Counts>): Promise<void> {
	const add = (model: string, key: string, n = 1) => {
		if (!(key in COUNTERS)) throw new Error(`unknown counter ${key}`);
		const c = (models[model] ??= {});
		c[key] = (c[key] ?? 0) + n;
	};
	let cwd = "/";
	const abs = (p: unknown) => path.resolve(cwd, String(p ?? ""));
	const responses: Response[] = [];
	const pending = new Map<string, { name: string; args: any; resp: number; model: string }>();
	const edits: EditRecord[] = [];
	const reads: { resp: number; file: string }[] = [];
	const syntaxErrors: { resp: number; text: string }[] = [];
	const files = new Map<string, string>();
	/** file -> its last event: which response, and whether that was an edit. */
	const lastSeen = new Map<string, { resp: number; edit: boolean }>();
	let lastFormatter = -1;
	let lastShell = -1;
	let run = 0;
	let runModel = "";
	let runFirstEdit = -1;
	let runPairs = new Map<string, number>();
	let runPartial = new Map<string, Set<number>>();
	let runPartialCalls = new Map<string, number>();
	// Consecutive responses that only look things up: [strict (read, grep, find, ls), also allowing bash].
	const chain = [
		{ length: 0, extraSpend: 0, model: "", keys: ["lookupChains", "lookupChainExtra", "lookupChainExtraSpend"] },
		{ length: 0, extraSpend: 0, model: "", keys: ["shellChains", "shellChainExtra", "shellChainExtraSpend"] },
	];
	const endChain = (c: (typeof chain)[number]) => {
		if (c.length >= 2) {
			add(c.model, c.keys[0]);
			add(c.model, c.keys[1], c.length - 1);
			add(c.model, c.keys[2], c.extraSpend);
		}
		c.length = 0;
		c.extraSpend = 0;
	};
	const closeRun = () => {
		chain.forEach(endChain);
		if (!runModel) return;
		add(runModel, "runs");
		for (const n of runPairs.values()) {
			if (n >= 3) {
				add(runModel, "repeatGroups");
				add(runModel, "repeatOps", n);
			}
		}
		for (const [target, n] of runPartialCalls) {
			if (n >= 3) {
				add(runModel, "partialReadGroups");
				add(runModel, "partialReads", n);
				add(runModel, "partialReadTurns", (runPartial.get(target)?.size ?? 1) - 1);
			}
		}
		runModel = "";
		runFirstEdit = -1;
		runPairs = new Map();
		runPartial = new Map();
		runPartialCalls = new Map();
	};

	// Rent: every piece of content with the line it entered on, and where compactions cut.
	const rentItems: { ord: number; kind: string; size: number; model: string; file?: string; until?: number }[] = [];
	const responseOrds: number[] = [];
	const ordOfEntry = new Map<string, number>();
	const compactions: { ord: number; firstKept: number }[] = [];
	const fileEvents = new Map<string, number[]>();
	const touch = (target: string, at: number) => {
		if (!fileEvents.has(target)) fileEvents.set(target, []);
		fileEvents.get(target)!.push(at);
	};
	const textBytes = (content: unknown): number =>
		typeof content === "string" ? bytes(content) : Array.isArray(content) ? content.reduce((n, c: any) => n + (typeof c?.text === "string" ? bytes(c.text) : 0), 0) : 0;
	let lastModel = "";
	let ord = 0;

	const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
	for await (const line of rl) {
		ord++;
		if (line.length < 20) continue;
		if (line.startsWith('{"type":"session"')) {
			try {
				cwd = String(JSON.parse(line).cwd ?? "/");
			} catch {}
			continue;
		}
		const entryId = /^\{"type":"[^"]+","id":"([^"]+)"/.exec(line);
		if (entryId) ordOfEntry.set(entryId[1], ord);
		if (line.startsWith('{"type":"compaction"') || line.startsWith('{"type":"custom_message"')) {
			try {
				const entry = JSON.parse(line);
				if (typeof entry.id === "string") ordOfEntry.set(entry.id, ord);
				if (entry.type === "compaction") {
					compactions.push({ ord, firstKept: ordOfEntry.get(entry.firstKeptEntryId) ?? ord });
					rentItems.push({ ord, kind: "summary", size: bytes(String(entry.summary ?? "")), model: lastModel });
				} else rentItems.push({ ord, kind: "injected", size: textBytes(entry.content), model: lastModel });
			} catch {}
			continue;
		}
		if (!line.includes('"role":"')) continue;
		let msg: any;
		try {
			const entry = JSON.parse(line);
			if (typeof entry?.id === "string") ordOfEntry.set(entry.id, ord);
			msg = entry?.message;
		} catch {
			continue;
		}
		if (!msg) continue;

		if (msg.role === "user") {
			closeRun();
			run++;
			rentItems.push({ ord, kind: "user", size: textBytes(msg.content), model: lastModel });
			continue;
		}

		if (msg.role === "assistant") {
			if (!msg.provider || !msg.model) continue;
			const model = `${msg.provider}/${msg.model}`.toLowerCase();
			const usage = msg.usage ?? {};
			const resp = responses.length;
			const reasoning = typeof usage.reasoning === "number" ? usage.reasoning : undefined;
			responses.push({
				model,
				cost: Number(usage.cost?.total) || 0,
				output: Number(usage.output) || 0,
				reasoning,
				context: (Number(usage.input) || 0) + (Number(usage.cacheRead) || 0) + (Number(usage.cacheWrite) || 0),
				ms: typeof msg.durationMs === "number" ? msg.durationMs : 0,
				run,
			});
			if (!runModel) runModel = model;
			lastModel = model;
			responseOrds.push(ord);
			add(model, "promptTokenTurns", responses[resp].context);
			const bucket = PROMPT_BUCKETS.find(([, below]) => responses[resp].context < below)![0];
			add(model, `promptResponses_${bucket}`);
			add(model, `promptSpend_${bucket}`, responses[resp].cost);
			add(model, "responses");
			add(model, "spend", Number(usage.cost?.total) || 0);
			add(model, "outputTokens", Number(usage.output) || 0);
			add(model, "costOutput", Number(usage.cost?.output) || 0);
			if (reasoning !== undefined) {
				add(model, "reasoningResponses");
				add(model, "reasoningTokens", reasoning);
			}
			let visible = 0;
			let thought = false;
			let lastCall = "";
			let editsHere = false;
			const called: string[] = [];
			for (const block of msg.content ?? []) {
				lastCall = "";
				if (block?.type === "thinking") thought = true;
				else if (block?.type === "text" && typeof block.text === "string") {
					visible += bytes(block.text);
					rentItems.push({ ord, kind: "assistantText", size: bytes(block.text), model });
				} else if (block?.type === "toolCall") {
					const name = String(block.name ?? "");
					rentItems.push({ ord, kind: EDITING.has(name) ? "callEdit" : name === "codemode" ? "callCodemode" : "callOther", size: bytes(JSON.stringify(block.arguments ?? {})), model });
					lastCall = name;
					called.push(name);
					visible += bytes(name) + bytes(JSON.stringify(block.arguments ?? {}));
					pending.set(block.id, { name, args: block.arguments, resp, model });
					if (EDITING.has(name)) editsHere = true;
				}
			}
			add(model, "visibleBytes", visible);
			if (called.length > 0) {
				add(model, "toolResponses");
				add(model, "toolCalls", called.length);
				if (called.length > 1) add(model, "multiCallResponses");
				add(model, "codemodeCalls", called.filter((n) => n === "codemode").length);
			}
			const fits = [called.length > 0 && called.every((n) => LOOKUP.has(n)), called.length > 0 && called.every((n) => LOOKUP.has(n) || n === "bash")];
			chain.forEach((c, k) => {
				if (!fits[k]) return endChain(c);
				if (c.length === 0) c.model = model;
				else c.extraSpend += Number(usage.cost?.total) || 0;
				c.length++;
			});
			if (!thought && !(Number(usage.reasoning) > 0) && (Number(usage.output) || 0) > 20 && visible > 0) {
				add(model, "plainBytes", visible);
				add(model, "plainTokens", Number(usage.output) || 0);
			}
			if (msg.stopReason === "length") {
				add(model, "stopLength");
				if (lastCall === "edit" || lastCall === "write") add(model, "stopLengthInEdit");
			}
			// Candidate 4: everything in the run after the response that makes its first edit.
			if (runFirstEdit >= 0) {
				add(model, "spendAfterFirstEdit", Number(usage.cost?.total) || 0);
				add(model, "responsesAfterFirstEdit");
				add(model, "outputAfterFirstEdit", Number(usage.output) || 0);
				add(model, "costOutputAfterFirstEdit", Number(usage.cost?.output) || 0);
				if (reasoning !== undefined) add(model, "reasoningAfterFirstEdit", reasoning);
			} else if (editsHere) {
				runFirstEdit = resp;
				add(model, "runsWithEdit");
				add(model, "contextAtFirstEdit", responses[resp].context);
				for (let i = resp; i >= 0 && responses[i].run === run; i--) {
					add(responses[i].model, "spendToFirstEdit", responses[i].cost);
					if (responses[i].reasoning !== undefined) add(responses[i].model, "reasoningToFirstEdit", responses[i].reasoning!);
				}
			}
			continue;
		}

		if (msg.role !== "toolResult") continue;
		{
			const tool = String(msg.toolName ?? "");
			const kind = tool === "read" ? "resultRead" : tool === "bash" ? "resultShell" : EDITING.has(tool) ? "resultEdit" : LOOKUP.has(tool) ? "resultLookup" : tool === "codemode" ? "resultCodemode" : "resultOther";
			const args = pending.get(msg.toolCallId)?.args;
			const target = (tool === "read" || tool === "edit" || tool === "write") && args?.path !== undefined ? abs(args.path) : undefined;
			if (target && !msg.isError) touch(target, ord);
			rentItems.push({ ord, kind, size: textBytes(msg.content), model: lastModel, file: tool === "read" ? target : undefined });
		}
		const call = pending.get(msg.toolCallId);
		if (!call) continue;
		pending.delete(msg.toolCallId);
		const text = Array.isArray(msg.content) ? msg.content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("\n") : "";
		const { name, args, resp, model } = call;
		if (Array.isArray(msg.nestedCalls?.calls)) add(model, "nestedCalls", msg.nestedCalls.calls.length);

		if (name === "bash") {
			const command = String(args?.command ?? "");
			lastShell = resp;
			if (FORMATTER.test(command)) lastFormatter = resp;
			if (SYNTAX_ERROR.test(text)) syntaxErrors.push({ resp, text: text.length > 20000 ? text.slice(0, 20000) : text });
			continue;
		}
		if (name === "read") {
			const target = abs(args?.path);
			reads.push({ resp, file: target });
			const partial = args?.offset !== undefined || args?.limit !== undefined;
			if (partial) {
				runPartialCalls.set(target, (runPartialCalls.get(target) ?? 0) + 1);
				if (!runPartial.has(target)) runPartial.set(target, new Set());
				runPartial.get(target)!.add(resp);
			}
			if (msg.isError) continue;
			lastSeen.set(target, { resp, edit: false });
			if (!partial && text && !HASHLINE_HEADER.test(text) && !TRUNCATED_READ.test(text) && !msg.content?.some((c: any) => c?.type === "image")) {
				files.set(target, text);
			}
			continue;
		}
		if (name === "write") {
			if (msg.isError) continue;
			const target = abs(args?.path);
			if (typeof args?.content === "string") files.set(target, args.content);
			lastSeen.set(target, { resp, edit: true });
			continue;
		}
		if (name === "hashline_edit") {
			// Its paths are inside the patch text; the reconstruction cannot follow it.
			if (!msg.isError) files.clear();
			continue;
		}
		if (name !== "edit") continue;

		const target = abs(args?.path);
		const ops = opsOf(args);
		add(model, "editCalls");
		if (msg.isError) {
			const kind = failureKind(text);
			add(model, "editFailed");
			add(model, FAILURE_COUNTER[kind]);
			const index = /edits\[(\d+)\]/.exec(text);
			const record: EditRecord = { resp, model, file: target, ok: false, kind, ops, failedOp: index ? Number(index[1]) : 0 };
			if (kind === "notFound") {
				const seen = lastSeen.get(target);
				if (!seen) add(model, "nfFileNeverSeen");
				else {
					if (lastFormatter > seen.resp) add(model, "nfAfterFormatter");
					if (lastShell > seen.resp) add(model, "nfAfterShell");
				}
				record.fileThen = files.get(target);
			}
			edits.push(record);
			continue;
		}

		add(model, "editOk");
		edits.push({ resp, model, file: target, ok: true, kind: "ok", ops, failedOp: -1 });
		const seen = lastSeen.get(target);
		if (seen?.edit) add(model, seen.resp === resp ? "reeditSameResponse" : "reeditNoRead");
		lastSeen.set(target, { resp, edit: true });

		let known = files.get(target);
		for (const op of ops) {
			const oldLines = linesOf(op.old);
			add(model, "ops");
			add(model, "oldBytes", bytes(op.old));
			add(model, "newBytes", bytes(op.new));
			add(model, oldLines.length === 1 ? "ops1" : oldLines.length === 2 ? "ops2" : "ops3");
			if (oldLines.length >= 3) {
				add(model, "oldBytes3", bytes(op.old));
				add(model, "anchorSavedBytes", bytes(oldLines.slice(1, -1).join("\n")) + 1);
			}
			const pair = `${op.old}\u0000${op.new}`;
			runPairs.set(pair, (runPairs.get(pair) ?? 0) + 1);

			if (known === undefined) continue;
			const startLine = uniqueLineOf(known, op.old);
			if (startLine < 0) {
				// The session's copy is out of date (a shell command or another tool changed the file).
				add(model, "fileStale");
				known = undefined;
				continue;
			}
			add(model, "opsFileKnown");
			if (oldLines.length >= 3) {
				add(model, "ops3FileKnown");
				const fileLines = linesOf(known).map((l) => l.trimEnd());
				const first = oldLines[0].trimEnd();
				const last = oldLines[oldLines.length - 1].trimEnd();
				const firstCount = fileLines.reduce((n, l) => n + (l === first ? 1 : 0), 0);
				const nextLast = fileLines.indexOf(last, startLine + 1);
				if (firstCount !== 1) add(model, "anchorFirstAmbiguous");
				else if (nextLast !== startLine + oldLines.length - 1) add(model, "anchorLastEarly");
				else add(model, "anchorOk");
			}
			known = known.replace(op.old, () => op.new);
		}
		if (known === undefined) files.delete(target);
		else files.set(target, known);
	}
	closeRun();

	// ── rent ───────────────────────────────────────────────────────────────
	if (responses.length > 0) {
		const first = responses[0];
		add(first.model, "sessions");
		add(first.model, "baseTokens", first.context);
		add(first.model, "baseTokenTurns", first.context * responses.length);
		/** Responses on lines after `after` and up to `upTo`. */
		const responsesBetween = (after: number, upTo: number): number => {
			const count = (limit: number) => {
				let lo = 0;
				let hi = responseOrds.length;
				while (lo < hi) {
					const mid = (lo + hi) >> 1;
					if (responseOrds[mid] <= limit) lo = mid + 1;
					else hi = mid;
				}
				return lo;
			};
			return Math.max(0, count(upTo) - count(after));
		};
		for (const item of rentItems) {
			if (item.size === 0) continue;
			const model = item.model || first.model;
			const dropped = compactions.find((c) => c.ord > item.ord && item.ord < c.firstKept);
			const end = dropped ? dropped.ord : Number.POSITIVE_INFINITY;
			const turns = responsesBetween(item.ord, end);
			add(model, `rentBytes_${item.kind}`, item.size);
			add(model, `rentTurns_${item.kind}`, item.size * turns);
			if (item.kind === "resultShell" && item.size > 8192) add(model, "longShellTurns", item.size * turns);
			if (item.kind === "resultRead" && item.size > 16384) add(model, "longReadTurns", item.size * turns);
			if (item.kind === "resultRead" && item.file) {
				const next = fileEvents.get(item.file)?.find((at) => at > item.ord);
				if (next !== undefined && next < end) add(model, "supersededReadTurns", item.size * responsesBetween(next, end));
			}
		}
	}

	// ── what followed each failure ──────────────────────────────────────────
	const spendBetween = (from: number, to: number) => {
		let spend = 0;
		let ms = 0;
		for (let i = from; i <= to && i < responses.length; i++) {
			spend += responses[i].cost;
			ms += responses[i].ms;
		}
		return { spend, ms, count: Math.max(0, Math.min(to, responses.length - 1) - from + 1) };
	};
	for (let i = 0; i < edits.length; i++) {
		const failed = edits[i];
		if (failed.kind !== "notFound" && failed.kind !== "notUnique") continue;
		const wanted = failed.ops[failed.failedOp];
		let exact: { edit: EditRecord; op: Op } | undefined;
		let loose: EditRecord | undefined;
		const followers: EditRecord[] = [];
		for (let j = i + 1; j < edits.length && edits[j].resp <= failed.resp + 6; j++) {
			const next = edits[j];
			// A call in the same response was written before the failure was known, so it is not a retry.
			if (!next.ok || next.file !== failed.file || next.resp === failed.resp) continue;
			if (next.resp <= failed.resp + 3) followers.push(next);
			const same = wanted ? next.ops.find((op) => op.new === wanted.new) : undefined;
			if (same) {
				exact = { edit: next, op: same };
				break;
			}
			if (!loose && next.resp <= failed.resp + 3) loose = next;
		}
		const retry = exact?.edit ?? loose;

		if (failed.kind === "notUnique") {
			if (!retry || retry.resp > failed.resp + 3) continue;
			const cost = spendBetween(failed.resp + 1, retry.resp);
			add(failed.model, "nuRetried");
			add(failed.model, "nuCascadeResponses", cost.count);
			add(failed.model, "nuCascadeSpend", cost.spend);
			continue;
		}

		if (!retry) add(failed.model, "nfNoRetry");
		else {
			const cost = spendBetween(failed.resp + 1, retry.resp);
			add(failed.model, exact ? "nfRetried" : "nfRetriedLoose");
			add(failed.model, "nfCascadeResponses", cost.count);
			add(failed.model, "nfCascadeSpend", cost.spend);
			add(failed.model, "nfCascadeMs", cost.ms);
			if (reads.some((r) => r.file === failed.file && r.resp > failed.resp && r.resp <= retry.resp)) add(failed.model, "nfRereadBeforeRetry");
		}
		if (!wanted) continue;
		const failedLines = trimmed(wanted.old);

		if (exact) {
			const retryLines = trimmed(exact.op.old);
			if (failedLines.length === retryLines.length && failedLines.every((l, k) => l === retryLines[k])) add(failed.model, "nfIndentOnly");
			else if (wanted.old.replace(/\s+/g, "") === exact.op.old.replace(/\s+/g, "")) add(failed.model, "nfWhitespaceOnly");
			else {
				const pool = new Map<string, number>();
				for (const l of retryLines) pool.set(l, (pool.get(l) ?? 0) + 1);
				let common = 0;
				for (const l of failedLines) {
					const n = pool.get(l) ?? 0;
					if (n > 0) {
						common++;
						pool.set(l, n - 1);
					}
				}
				const share = common / Math.max(failedLines.length, retryLines.length);
				add(failed.model, share >= 0.8 ? "nfOverlapHigh" : share >= 0.5 ? "nfOverlapMid" : "nfOverlapLow");
			}
		}

		if (failed.fileThen === undefined) continue;
		add(failed.model, "nfFileKnown");
		const fileLines = trimmed(failed.fileThen);
		const runs = findLineRuns(fileLines, failedLines);
		// Where the model's own next successful edits of this file landed, in that same copy of it: the retry
		// carrying the same new text when there is one, otherwise every replacement it made in the next 3 responses.
		const answers = (exact ? [exact.op] : followers.flatMap((e) => e.ops))
			.map((op) => ({ start: uniqueLineOf(failed.fileThen!, op.old), span: linesOf(op.old).length }))
			.filter((a) => a.start >= 0);
		const overlaps = (start: number, span: number) => answers.some((a) => start < a.start + a.span && a.start < start + span);
		if (runs.length === 0) add(failed.model, "nfIndentNone");
		else if (runs.length > 1) add(failed.model, "nfIndentAmbiguous");
		else {
			add(failed.model, "nfIndentUnique");
			add(failed.model, answers.length === 0 ? "nfRescueUnchecked" : overlaps(runs[0], failedLines.length) ? "nfRescueRight" : "nfRescueWrong");
		}
		const nearest = nearestWindow(fileLines, failedLines);
		if (nearest >= 0 && answers.length > 0) add(failed.model, overlaps(nearest, failedLines.length) ? "nfNearestRight" : "nfNearestWrong");
	}

	// ── candidate 3: edit, syntax error naming the file, edit again ─────────
	let cursor = -1;
	for (let i = 0; i < edits.length; i++) {
		const first = edits[i];
		if (!first.ok || first.resp <= cursor) continue;
		const base = path.basename(first.file);
		const error = syntaxErrors.find((e) => e.resp > first.resp && e.resp <= first.resp + 2 && e.text.includes(base));
		if (!error) continue;
		const second = edits.find((e, j) => j > i && e.file === first.file && e.resp > error.resp && e.resp <= error.resp + 2);
		if (!second) continue;
		const cost = spendBetween(first.resp + 1, second.resp);
		add(first.model, "syntaxLoops");
		add(first.model, "syntaxLoopResponses", cost.count);
		add(first.model, "syntaxLoopSpend", cost.spend);
		cursor = second.resp;
	}
}

function listSessionFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(d, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
		}
	};
	walk(dir);
	return out;
}

async function main() {
	const argv = process.argv.slice(2);
	const dirs: string[] = [];
	let out = "edit-counts.json";
	let skip = new Set<string>();
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--out") out = argv[++i];
		else if (argv[i] === "--skip-names") skip = new Set(fs.readFileSync(argv[++i], "utf8").split("\n").filter(Boolean));
		else dirs.push(argv[i]);
	}
	if (dirs.length === 0) {
		console.error("usage: node scripts/edit-counts.ts [--out counts.json] [--skip-names names.txt] <sessions dir>...");
		process.exit(2);
	}
	const seen = new Set<string>(skip);
	const files: string[] = [];
	for (const dir of dirs) {
		for (const file of listSessionFiles(dir)) {
			const name = path.basename(file);
			if (seen.has(name)) continue;
			seen.add(name);
			files.push(file);
		}
	}
	const models: Record<string, Counts> = {};
	let next = 0;
	let failedFiles = 0;
	const worker = async () => {
		while (next < files.length) {
			const file = files[next++];
			try {
				await countFile(file, models);
			} catch (error) {
				failedFiles++;
				console.error(`skipped ${file}: ${error instanceof Error ? error.message : error}`);
			}
		}
	};
	await Promise.all(Array.from({ length: 6 }, worker));
	const total: Counts = {};
	for (const counts of Object.values(models)) for (const [key, n] of Object.entries(counts)) total[key] = (total[key] ?? 0) + n;
	fs.writeFileSync(out, JSON.stringify({ version: COUNTS_VERSION, files: files.length, failedFiles, names: files.map((f) => path.basename(f)), total, models }));
	console.log(`${files.length} session files, ${failedFiles} skipped, ${Object.keys(models).length} models -> ${out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) await main();
