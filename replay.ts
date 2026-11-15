/**
 * No-call replay of Pi session transcripts: what would hashline have changed for each model?
 *
 * Everything is read from what Pi recorded. For each built-in `edit` the transcript holds the patch that
 * was applied, so the hashline call that makes the same change can be written out and sized. For each
 * `read` the text returned is there, so the line-number prefixes hashline adds can be counted. Token
 * usage, cost, cache reads, response duration and compaction points are recorded per response.
 *
 * Derived, not recorded:
 *  - bytes per token, per model: bytes written divided by output tokens billed, on responses with no thinking;
 *  - the size of a hashline edit result, from a fit over the user's own recorded hashline results
 *    (falling back to coefficients fitted on 147 real calls);
 *  - the hashline side of every comparison, which assumes the model writes the minimal hashline patch.
 *
 * Edits made through `codemode` leave no patch and cannot be replayed; totals are scaled from the direct
 * edits and reads that can, and the coverage is reported with every row.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

export const REPLAY_VERSION = 4;
/**
 * A figure is "settled" when the user's own sessions agree on which side of zero it falls: the sessions are
 * redrawn with replacement many times, and the figure must keep its sign in 95% of the draws. Each figure is
 * judged on its own sample, so Speed (which only counts edits from responses with a recorded duration) can
 * be unsettled while Cost is settled. Below this many edits, or this few sessions, nothing is settled:
 * the redraws themselves cannot be trusted on so little.
 */
export const MIN_EDITS_TO_JUDGE = 30;
const MIN_UNITS_TO_JUDGE = 5;
const DRAWS = 200;

/** Per-model sums taken from one session file. All additive, so files can be cached and merged. */
interface Partial {
	responses: number;
	spend: number;
	durationMs: number;
	timedResponses: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costInput: number;
	costOutput: number;
	costCacheRead: number;
	costCacheWrite: number;
	visibleBytes: number;
	visibleTokens: number;
	/** Output tokens per second on responses of 300+ output tokens (a bounded sample). */
	rates: number[];

	editsOk: number;
	editsFailed: number;
	editsNotFound: number;
	editsNotUnique: number;
	editsViaCodemodeOk: number;
	editsReplayed: number;
	failedEditBytes: number;
	/** Built-in call bytes and the hashline call bytes that make the same change. */
	builtinCallBytes: number;
	hashlineCallBytes: number;
	/**
	 * The same, restricted to edits made in responses that recorded a duration. Speed is computed from these
	 * alone, so sessions written before Pi recorded durations add to Cost and failure counts but not to Speed.
	 */
	timedEditsOk: number;
	timedEditsReplayed: number;
	timedCallDelta: number;
	/** Context change from the edit call itself and from the built-in result text: [billed once, byte-turns after]. */
	editContext: [number, number];
	/** Terms of the hashline result size, weighted the same way: [lines, new lines x line bytes, ops x line bytes]. */
	editResultOnce: [number, number, number];
	editResultTurns: [number, number, number];

	reads: number;
	readsMeasured: number;
	readLines: number;
	/** Bytes of line-number prefixes hashline would add: [billed once, byte-turns after]. */
	readContext: [number, number];

	hashlineCalls: number;
	hashlineFailed: number;
	hashlineFailKinds: Record<string, number>;
	/** Normal-equation sums for: result lines - 1 = a * new lines + b * ops. */
	fit: [number, number, number, number, number, number];
}

interface FileEntry {
	size: number;
	mtimeMs: number;
	models: Record<string, Partial>;
}

interface Cache {
	version: number;
	files: Record<string, FileEntry>;
	/** The table built from exactly these files and this seed, reused while neither changes. */
	built?: { signature: string; table: ReplayTable };
}

export interface ReplayRow {
	model: string;
	responses: number;
	/** Recorded spend in dollars across all of the model's responses. */
	spend: number;
	responseSeconds: number;
	tokensPerSecond: number | null;
	bytesPerToken: number | null;
	/** Share of input tokens served from cache, as recorded. */
	cacheRate: number | null;
	edits: { ok: number; failed: number; notFound: number; notUnique: number; replayed: number; viaCodemode: number };
	reads: { total: number; measured: number; perEdit: number | null; avgLines: number | null };
	/** Real hashline calls found in the transcripts for this model. */
	hashline: { calls: number; failed: number; failKinds: Record<string, number> };
	/** Output tokens per built-in edit call, and per equivalent hashline call. */
	outputPerEdit: { builtin: number; hashline: number } | null;
	/** Input tokens hashline adds to each read. */
	inputPerRead: number | null;
	/** Positive means hashline is better. Null when the model lacks the recorded data to compute it. */
	timeSavedSeconds: number | null;
	timeSavedPct: number | null;
	secondsPerEdit: number | null;
	costSaved: number | null;
	costSavedPct: number | null;
	/**
	 * Where the cost figure comes from. Token counts are hashline minus built-in (negative = fewer with hashline);
	 * prices are dollars per million tokens as recorded for this model.
	 */
	breakdown: {
		outputTokens: number;
		inputTokensOnce: number;
		inputTokenTurns: number;
		fromReads: { once: number; turns: number };
		fromEdits: { once: number; turns: number };
		pricePerMillion: { output: number; freshInput: number; laterInput: number } | null;
	} | null;
	/** Output tokens spent on built-in edits that failed. */
	failedEditTokens: number | null;
	/** Replayed edits the Speed figure rests on (those from responses with a recorded duration). */
	speedEdits: number;
	/** Replayed edits the Cost figure rests on. */
	costEdits: number;
	/** True when the user's sessions agree on the sign of that figure (see `MIN_EDITS_TO_JUDGE`). */
	speedSettled: boolean;
	costSettled: boolean;
}

/** Per-model sums computed elsewhere (another machine, an archive) and merged into every local replay. */
export interface ReplaySeed {
	version: number;
	generatedAt: string;
	/** Each source is split into units (groups of whole sessions) so its sessions can be redrawn like local ones. */
	sources: { label: string; host?: string; files: number; units: Record<string, Partial>[] }[];
}

export interface ReplayTable {
	version: number;
	generatedAt: string;
	sessionsDir: string;
	sessionFiles: number;
	/** Imported sources merged into the rows, when a seed file is present. */
	imported?: { label: string; files: number }[];
	resultModel: { perNewLine: number; perOp: number; source: string };
	rows: ReplayRow[];
}

// Fitted on 147 recorded hashline results: result lines = 1 + 0.20 x new lines + 10.97 x ops.
const DEFAULT_RESULT_FIT = { perNewLine: 0.2, perOp: 10.97 };
const RATE_SAMPLE = 40;

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

function emptyPartial(): Partial {
	return {
		responses: 0,
		spend: 0,
		durationMs: 0,
		timedResponses: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		costInput: 0,
		costOutput: 0,
		costCacheRead: 0,
		costCacheWrite: 0,
		visibleBytes: 0,
		visibleTokens: 0,
		rates: [],
		editsOk: 0,
		editsFailed: 0,
		editsNotFound: 0,
		editsNotUnique: 0,
		editsViaCodemodeOk: 0,
		editsReplayed: 0,
		failedEditBytes: 0,
		builtinCallBytes: 0,
		hashlineCallBytes: 0,
		timedEditsOk: 0,
		timedEditsReplayed: 0,
		timedCallDelta: 0,
		editContext: [0, 0],
		editResultOnce: [0, 0, 0],
		editResultTurns: [0, 0, 0],
		reads: 0,
		readsMeasured: 0,
		readLines: 0,
		readContext: [0, 0],
		hashlineCalls: 0,
		hashlineFailed: 0,
		hashlineFailKinds: {},
		fit: [0, 0, 0, 0, 0, 0],
	};
}

function addPartial(into: Partial, from: Partial, extras = true): void {
	for (const key of Object.keys(from) as (keyof Partial)[]) {
		const value = from[key];
		if (typeof value === "number") (into[key] as number) += value;
		else if (key === "rates") {
			if (extras) into.rates.push(...(value as number[]));
		} else if (key === "hashlineFailKinds") {
			if (!extras) continue;
			for (const [kind, n] of Object.entries(value as Record<string, number>)) into.hashlineFailKinds[kind] = (into.hashlineFailKinds[kind] ?? 0) + n;
		} else if (Array.isArray(value)) {
			const target = into[key] as number[];
			for (let i = 0; i < value.length; i++) target[i] += (value as number[])[i];
		}
	}
}

/**
 * The hashline call that makes the same change as a recorded unified diff: one `PUT`/`CUT` per run of
 * changed lines, `+` rows for the new text, no context. Returns its text, the number of ops, the number
 * of new lines and the average length of a changed or context line.
 */
export function hashlineFromPatch(patch: string, filePath: string): { input: string; ops: number; newLines: number; lineBytes: number } {
	const out: string[] = [`[${filePath}#0000]`];
	let oldLine = 0;
	let run: { start: number; removed: number; added: string[] } | null = null;
	let ops = 0;
	let newLines = 0;
	let seenBytes = 0;
	let seenLines = 0;
	const flush = () => {
		if (!run) return;
		ops++;
		if (run.added.length === 0) out.push(`CUT ${run.start}.=${run.start + run.removed - 1}`);
		else {
			out.push(run.removed > 0 ? `PUT ${run.start}.=${run.start + run.removed - 1}:` : `PUT <${run.start}:`);
			for (const text of run.added) out.push(/^[+-]/.test(text) ? `++${text}`.replace(/^\+\+-/, "+-") : `+${text}`);
			newLines += run.added.length;
		}
		run = null;
	};
	for (const line of patch.split("\n")) {
		const hunk = /^@@ -(\d+)/.exec(line);
		if (hunk) {
			flush();
			oldLine = Number(hunk[1]);
			continue;
		}
		if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("\\")) continue;
		const mark = line[0];
		const text = line.slice(1);
		if (mark === "-") {
			run ??= { start: oldLine, removed: 0, added: [] };
			run.removed++;
			oldLine++;
		} else if (mark === "+") {
			run ??= { start: oldLine, removed: 0, added: [] };
			run.added.push(text);
			seenBytes += bytes(text);
			seenLines++;
		} else if (mark === " ") {
			flush();
			oldLine++;
			seenBytes += bytes(text);
			seenLines++;
		}
	}
	flush();
	return { input: out.join("\n"), ops, newLines, lineBytes: seenLines > 0 ? seenBytes / seenLines : 0 };
}

/** Bytes of `N:` prefixes and the `[path#TAG]` header hashline adds to a read of `lineCount` lines starting at `firstLine`. */
export function readOverheadBytes(lineCount: number, firstLine: number, filePath: string): number {
	let total = bytes(filePath) + 8;
	let line = firstLine;
	const last = firstLine + lineCount - 1;
	while (line <= last) {
		const digits = String(line).length;
		const end = Math.min(last, 10 ** digits - 1);
		total += (end - line + 1) * (digits + 1);
		line = end + 1;
	}
	return total;
}

function failureKind(text: string): "notFound" | "notUnique" | "other" {
	if (/Could not find/i.test(text)) return "notFound";
	if (/Found \d+ occurrences|must be unique|multiple/i.test(text)) return "notUnique";
	return "other";
}

const HASHLINE_HEADER = /^\[[^\]\n]+#[0-9A-Fa-f]{3,6}\]\n/;

type Item =
	| { kind: "read"; model: string; ord: number; bytes: number }
	| { kind: "edit"; model: string; ord: number; context: number; lines: number; newLineBytes: number; opBytes: number };

/** Scan one session file into per-model sums. */
export async function replayFile(file: string): Promise<Record<string, Partial>> {
	const models: Record<string, Partial> = {};
	const of = (model: string): Partial => (models[model] ??= emptyPartial());
	const ordOfEntry = new Map<string, number>();
	const responseOrds: number[] = [];
	const compactions: { ord: number; firstKept: number }[] = [];
	const items: Item[] = [];
	const pending = new Map<string, { name: string; args: any; model: string; ord: number; timed: boolean }>();
	let model = "";
	let ord = 0;

	const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
	for await (const line of rl) {
		ord++;
		if (line.length < 20) continue;
		const isMessage = line.includes('"role":"assistant"') || line.includes('"role":"toolResult"');
		const isCompaction = line.startsWith('{"type":"compaction"');
		if (!isMessage && !isCompaction) {
			// Entry ids are still needed for compaction boundaries; pull the id without a full parse.
			const id = /^\{"type":"[^"]+","id":"([^"]+)"/.exec(line);
			if (id) ordOfEntry.set(id[1], ord);
			continue;
		}
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof entry?.id === "string") ordOfEntry.set(entry.id, ord);
		if (entry?.type === "compaction") {
			compactions.push({ ord, firstKept: ordOfEntry.get(entry.firstKeptEntryId) ?? ord });
			continue;
		}
		const msg = entry?.message;
		if (!msg) continue;

		if (msg.role === "assistant") {
			if (!msg.provider || !msg.model) continue;
			model = `${msg.provider}/${msg.model}`.toLowerCase();
			const p = of(model);
			const usage = msg.usage ?? {};
			const cost = usage.cost ?? {};
			p.responses++;
			responseOrds.push(ord);
			p.spend += Number(cost.total) || 0;
			p.input += Number(usage.input) || 0;
			p.output += Number(usage.output) || 0;
			p.cacheRead += Number(usage.cacheRead) || 0;
			p.cacheWrite += Number(usage.cacheWrite) || 0;
			p.costInput += Number(cost.input) || 0;
			p.costOutput += Number(cost.output) || 0;
			p.costCacheRead += Number(cost.cacheRead) || 0;
			p.costCacheWrite += Number(cost.cacheWrite) || 0;
			if (typeof msg.durationMs === "number" && msg.durationMs > 0) {
				p.durationMs += msg.durationMs;
				p.timedResponses++;
				if (usage.output >= 300 && msg.durationMs > 500 && (p.rates.length < RATE_SAMPLE || Math.random() < 0.25)) {
					const rate = usage.output / (msg.durationMs / 1000);
					if (p.rates.length < RATE_SAMPLE) p.rates.push(rate);
					else p.rates[Math.floor(Math.random() * RATE_SAMPLE)] = rate;
				}
			}
			let visible = 0;
			let thought = false;
			for (const block of msg.content ?? []) {
				if (block?.type === "thinking") thought = true;
				if (block?.type === "text" && typeof block.text === "string") visible += bytes(block.text);
				else if (block?.type === "toolCall") {
					visible += bytes(String(block.name ?? "")) + bytes(JSON.stringify(block.arguments ?? {}));
					if (block.name === "read" || block.name === "edit" || block.name === "hashline_edit") {
						pending.set(block.id, { name: block.name, args: block.arguments, model, ord, timed: typeof msg.durationMs === "number" && msg.durationMs > 0 });
					}
				}
			}
			// Bytes per token is taken only from responses with no thinking, where every output token is visible text.
			const visibleTokens = Number(usage.output) || 0;
			if (!thought && !(Number(usage.reasoning) > 0) && visibleTokens > 20 && visible > 0) {
				p.visibleBytes += visible;
				p.visibleTokens += visibleTokens;
			}
			continue;
		}

		if (msg.role !== "toolResult") continue;
		const text = Array.isArray(msg.content) ? msg.content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("\n") : "";
		const call = pending.get(msg.toolCallId);
		if (call) pending.delete(msg.toolCallId);

		// Calls made through codemode carry arguments and a status, but no result text or patch.
		if (model) {
			for (const nested of msg.nestedCalls?.calls ?? []) {
				const p = of(model);
				if (nested?.name === "read") p.reads++;
				else if (nested?.name === "edit") {
					if (nested.status === "ok") {
						p.editsOk++;
						p.editsViaCodemodeOk++;
					} else if (nested.status === "error") {
						p.editsFailed++;
						const kind = failureKind(String(nested.error ?? ""));
						if (kind === "notFound") p.editsNotFound++;
						else if (kind === "notUnique") p.editsNotUnique++;
					}
				}
			}
		}
		if (!call) continue;
		const p = of(call.model);

		if (call.name === "read") {
			p.reads++;
			if (msg.isError || !text || HASHLINE_HEADER.test(text)) continue;
			const lineCount = text.split("\n").length;
			p.readsMeasured++;
			p.readLines += lineCount;
			items.push({ kind: "read", model: call.model, ord, bytes: readOverheadBytes(lineCount, Number(call.args?.offset) || 1, String(call.args?.path ?? "")) });
		} else if (call.name === "edit") {
			const callBytes = bytes(JSON.stringify(call.args ?? {}));
			if (msg.isError) {
				p.editsFailed++;
				p.failedEditBytes += callBytes;
				const kind = failureKind(text);
				if (kind === "notFound") p.editsNotFound++;
				else if (kind === "notUnique") p.editsNotUnique++;
				continue;
			}
			p.editsOk++;
			if (call.timed) p.timedEditsOk++;
			const patch = msg.details?.patch;
			if (typeof patch !== "string" || !patch.includes("@@")) continue;
			const h = hashlineFromPatch(patch, String(call.args?.path ?? ""));
			if (h.ops === 0) continue;
			const hashlineBytes = bytes(JSON.stringify({ input: h.input }));
			p.editsReplayed++;
			p.builtinCallBytes += callBytes;
			p.hashlineCallBytes += hashlineBytes;
			if (call.timed) {
				p.timedEditsReplayed++;
				p.timedCallDelta += hashlineBytes - callBytes;
			}
			const numbered = h.lineBytes + 5; // a result row is a line of the file plus its `N:` prefix
			items.push({ kind: "edit", model: call.model, ord, context: hashlineBytes - callBytes - bytes(text), lines: numbered, newLineBytes: h.newLines * numbered, opBytes: h.ops * numbered });
		} else if (call.name === "hashline_edit") {
			p.hashlineCalls++;
			if (msg.isError) {
				p.hashlineFailed++;
				const kind = String(msg.details?.errorKind ?? "other");
				p.hashlineFailKinds[kind] = (p.hashlineFailKinds[kind] ?? 0) + 1;
				continue;
			}
			const input = String(call.args?.input ?? "");
			const newLines = input.split("\n").filter((l) => l.startsWith("+")).length;
			const ops = input.split("\n").filter((l) => /^(PUT|CUT|MV|REM)\b/.test(l)).length;
			const extra = text.split("\n").length - 1;
			if (ops > 0) {
				p.fit[0] += newLines * newLines;
				p.fit[1] += newLines * ops;
				p.fit[2] += ops * ops;
				p.fit[3] += newLines * extra;
				p.fit[4] += ops * extra;
				p.fit[5] += 1;
			}
		}
	}

	// How many later responses re-read each item: every response after it, until a compaction drops it.
	const responsesBetween = (after: number, upTo: number): number => {
		let lo = 0;
		let hi = responseOrds.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (responseOrds[mid] <= after) lo = mid + 1;
			else hi = mid;
		}
		const first = lo;
		hi = responseOrds.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (responseOrds[mid] <= upTo) lo = mid + 1;
			else hi = mid;
		}
		return lo - first;
	};
	for (const item of items) {
		const dropped = compactions.find((c) => c.ord > item.ord && item.ord < c.firstKept);
		const later = responsesBetween(item.ord, dropped ? dropped.ord : Number.POSITIVE_INFINITY);
		const once = later > 0 ? 1 : 0;
		const turns = Math.max(0, later - 1);
		const p = of(item.model);
		if (item.kind === "read") {
			p.readContext[0] += item.bytes * once;
			p.readContext[1] += item.bytes * turns;
		} else {
			p.editContext[0] += item.context * once;
			p.editContext[1] += item.context * turns;
			p.editResultOnce[0] += item.lines * once;
			p.editResultOnce[1] += item.newLineBytes * once;
			p.editResultOnce[2] += item.opBytes * once;
			p.editResultTurns[0] += item.lines * turns;
			p.editResultTurns[1] += item.newLineBytes * turns;
			p.editResultTurns[2] += item.opBytes * turns;
		}
	}
	return models;
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

const median = (values: number[]): number | null => {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[sorted.length >> 1];
};

interface Core {
	cacheRate: number | null;
	prices: { out: number; fresh: number; later: number } | null;
	editScale: number;
	readScale: number;
	outputBytes: number;
	onceBytes: number;
	turnBytes: number;
	timedEdits: number;
	timeSavedSeconds: number | null;
	costChange: number | null;
	timeSavedPct: number | null;
	costSavedPct: number | null;
}

/** The figures for one set of sums. The model's token rate and bytes-per-token are passed in, not re-derived. */
function core(p: Partial, resultModel: { perNewLine: number; perOp: number }, bytesPerToken: number | null, tokensPerSecond: number | null): Core {
	const allInput = p.input + p.cacheRead + p.cacheWrite;
	const cacheRate = allInput > 0 ? p.cacheRead / allInput : null;

	// Recorded prices per token.
	const priceOut = p.output > 0 && p.costOutput > 0 ? p.costOutput / p.output : null;
	const fresh = p.input + p.cacheWrite;
	const priceFresh = fresh > 0 && p.costInput + p.costCacheWrite > 0 ? (p.costInput + p.costCacheWrite) / fresh : null;
	const priceCached = p.cacheRead > 0 && p.costCacheRead > 0 ? p.costCacheRead / p.cacheRead : priceFresh;
	const priceLater = priceFresh !== null && priceCached !== null && cacheRate !== null ? cacheRate * priceCached + (1 - cacheRate) * priceFresh : null;
	const prices = priceOut !== null && priceFresh !== null && priceLater !== null ? { out: priceOut, fresh: priceFresh, later: priceLater } : null;

	// Scale what could be replayed up to everything the model did.
	const editScale = p.editsReplayed > 0 ? p.editsOk / p.editsReplayed : 0;
	const readScale = p.readsMeasured > 0 ? p.reads / p.readsMeasured : 0;
	const resultBytes = (sums: [number, number, number]) => sums[0] + resultModel.perNewLine * sums[1] + resultModel.perOp * sums[2];
	const outputBytes = editScale * (p.hashlineCallBytes - p.builtinCallBytes);
	const onceBytes = editScale * (p.editContext[0] + resultBytes(p.editResultOnce)) + readScale * p.readContext[0];
	const turnBytes = editScale * (p.editContext[1] + resultBytes(p.editResultTurns)) + readScale * p.readContext[1];

	const enough = p.editsReplayed > 0 && bytesPerToken !== null;
	// Speed uses only edits from responses with a recorded duration, scaled by the same coverage as the rest.
	const timedEdits = p.timedEditsReplayed > 0 ? p.timedEditsReplayed * editScale : 0;
	const timedTokens = enough && p.timedEditsReplayed > 0 ? (editScale * p.timedCallDelta) / bytesPerToken! : null;
	const timeSavedSeconds = timedTokens !== null && tokensPerSecond ? -timedTokens / tokensPerSecond : null;
	const costChange = enough && prices ? (outputBytes * prices.out + onceBytes * prices.fresh + turnBytes * prices.later) / bytesPerToken! : null;
	return {
		cacheRate,
		prices,
		editScale,
		readScale,
		outputBytes,
		onceBytes,
		turnBytes,
		timedEdits,
		timeSavedSeconds,
		costChange,
		timeSavedPct: timeSavedSeconds !== null && p.durationMs > 0 ? (100 * timeSavedSeconds) / (p.durationMs / 1000) : null,
		costSavedPct: costChange !== null && p.spend > 0 ? (-100 * costChange) / p.spend : null,
	};
}

/** Small deterministic generator, so the same sessions always give the same verdict. */
function seededRandom(text: string): () => number {
	let a = 2166136261;
	for (let i = 0; i < text.length; i++) a = Math.imul(a ^ text.charCodeAt(i), 16777619);
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Do the model's sessions, redrawn with replacement, keep each figure on one side of zero? */
function settledFigures(
	model: string,
	units: Partial[],
	total: Partial,
	resultModel: { perNewLine: number; perOp: number },
	bytesPerToken: number | null,
	tokensPerSecond: number | null,
): { speed: boolean; cost: boolean } {
	if (units.length < MIN_UNITS_TO_JUDGE || bytesPerToken === null) return { speed: false, cost: false };
	const judgeSpeed = total.timedEditsReplayed >= MIN_EDITS_TO_JUDGE && tokensPerSecond !== null;
	const judgeCost = total.editsReplayed >= MIN_EDITS_TO_JUDGE;
	if (!judgeSpeed && !judgeCost) return { speed: false, cost: false };
	const random = seededRandom(model);
	const speeds: number[] = [];
	const costs: number[] = [];
	for (let draw = 0; draw < DRAWS; draw++) {
		const sum = emptyPartial();
		for (let i = 0; i < units.length; i++) addPartial(sum, units[Math.floor(random() * units.length)], false);
		const c = core(sum, resultModel, bytesPerToken, tokensPerSecond);
		if (c.timeSavedPct !== null) speeds.push(c.timeSavedPct);
		if (c.costSavedPct !== null) costs.push(c.costSavedPct);
	}
	const oneSided = (values: number[]): boolean => {
		if (values.length < DRAWS * 0.95) return false;
		const sorted = values.sort((x, y) => x - y);
		const low = sorted[Math.floor(0.025 * sorted.length)];
		const high = sorted[Math.min(sorted.length - 1, Math.floor(0.975 * sorted.length))];
		return low > 0 || high < 0;
	};
	return { speed: judgeSpeed && oneSided(speeds), cost: judgeCost && oneSided(costs) };
}

/**
 * Turn merged per-model sums into the table rows. `units` holds the per-session (or per-group) sums each model
 * total was built from; without them no figure can be called settled. Exported for tests.
 */
export async function buildRows(
	models: Record<string, Partial>,
	units?: Map<string, Partial[]>,
): Promise<{ rows: ReplayRow[]; resultModel: ReplayTable["resultModel"] }> {
	// Fit the hashline result size on the user's own hashline results when there are enough of them.
	const fit = [0, 0, 0, 0, 0, 0];
	for (const p of Object.values(models)) for (let i = 0; i < 6; i++) fit[i] += p.fit[i];
	let resultModel: ReplayTable["resultModel"] = { ...DEFAULT_RESULT_FIT, source: "default, fitted on 147 recorded hashline results" };
	const det = fit[0] * fit[2] - fit[1] * fit[1];
	if (fit[5] >= 30 && Math.abs(det) > 1e-9) {
		const a = (fit[3] * fit[2] - fit[4] * fit[1]) / det;
		const b = (fit[0] * fit[4] - fit[1] * fit[3]) / det;
		if (a >= 0 && a <= 2 && b >= 0 && b <= 60) resultModel = { perNewLine: +a.toFixed(3), perOp: +b.toFixed(2), source: `fitted on ${fit[5]} recorded hashline results` };
	}

	const pooledBytes = Object.values(models).reduce((n, p) => n + p.visibleBytes, 0);
	const pooledTokens = Object.values(models).reduce((n, p) => n + p.visibleTokens, 0);
	const pooledBytesPerToken = pooledTokens > 5000 ? pooledBytes / pooledTokens : null;

	const rows: ReplayRow[] = [];
	for (const [model, p] of Object.entries(models)) {
		if (p.responses === 0) continue;
		const bytesPerToken = p.visibleTokens > 5000 ? p.visibleBytes / p.visibleTokens : pooledBytesPerToken;
		const tokensPerSecond = median(p.rates);
		const c = core(p, resultModel, bytesPerToken, tokensPerSecond);
		const enough = p.editsReplayed > 0 && bytesPerToken !== null;
		const perToken = (b: number) => (bytesPerToken !== null ? b / bytesPerToken : 0);
		const breakdown: ReplayRow["breakdown"] = enough
			? {
					outputTokens: perToken(c.outputBytes),
					inputTokensOnce: perToken(c.onceBytes),
					inputTokenTurns: perToken(c.turnBytes),
					fromReads: { once: perToken(c.readScale * p.readContext[0]), turns: perToken(c.readScale * p.readContext[1]) },
					fromEdits: { once: perToken(c.onceBytes - c.readScale * p.readContext[0]), turns: perToken(c.turnBytes - c.readScale * p.readContext[1]) },
					pricePerMillion: c.prices ? { output: c.prices.out * 1e6, freshInput: c.prices.fresh * 1e6, laterInput: c.prices.later * 1e6 } : null,
				}
			: null;
		const modelUnits = units?.get(model) ?? [];
		// Redrawing sessions is the only heavy step; yield first so an open picker stays responsive.
		if (modelUnits.length >= MIN_UNITS_TO_JUDGE && p.editsReplayed >= MIN_EDITS_TO_JUDGE) await new Promise<void>((resolve) => setImmediate(resolve));
		const settled = settledFigures(model, modelUnits, p, resultModel, bytesPerToken, tokensPerSecond);

		rows.push({
			model,
			responses: p.responses,
			spend: p.spend,
			responseSeconds: p.durationMs / 1000,
			tokensPerSecond,
			bytesPerToken,
			cacheRate: c.cacheRate,
			edits: { ok: p.editsOk, failed: p.editsFailed, notFound: p.editsNotFound, notUnique: p.editsNotUnique, replayed: p.editsReplayed, viaCodemode: p.editsViaCodemodeOk },
			reads: { total: p.reads, measured: p.readsMeasured, perEdit: p.editsOk > 0 ? p.reads / p.editsOk : null, avgLines: p.readsMeasured > 0 ? p.readLines / p.readsMeasured : null },
			hashline: { calls: p.hashlineCalls, failed: p.hashlineFailed, failKinds: p.hashlineFailKinds },
			outputPerEdit: enough ? { builtin: p.builtinCallBytes / p.editsReplayed / bytesPerToken!, hashline: p.hashlineCallBytes / p.editsReplayed / bytesPerToken! } : null,
			inputPerRead: p.readsMeasured > 0 && bytesPerToken !== null ? p.readContext[0] / Math.max(1, p.readsMeasured) / bytesPerToken : null,
			timeSavedSeconds: c.timeSavedSeconds,
			timeSavedPct: c.timeSavedPct,
			secondsPerEdit: c.timeSavedSeconds !== null && c.timedEdits > 0 ? c.timeSavedSeconds / c.timedEdits : null,
			costSaved: c.costChange !== null ? -c.costChange : null,
			costSavedPct: c.costSavedPct,
			breakdown,
			failedEditTokens: bytesPerToken !== null ? p.failedEditBytes / bytesPerToken : null,
			speedEdits: p.timedEditsReplayed,
			costEdits: p.editsReplayed,
			speedSettled: settled.speed,
			costSettled: settled.cost,
		});
	}
	rows.sort((a, b) => b.edits.replayed - a.edits.replayed || b.responses - a.responses);
	return { rows, resultModel };
}

export interface ReplayOptions {
	sessionsDir?: string;
	/** Imported per-model sums to merge in. Defaults to `hashline-replay-seed.json` next to the sessions directory; `null` disables. */
	seedPath?: string | null;
	/** Per-file results are cached here by size and modification time. Pass `null` to disable. */
	cachePath?: string | null;
	onProgress?: (done: number, total: number) => void;
}

export function defaultSessionsDir(agentDir?: string): string {
	return path.join(agentDir || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi/agent"), "sessions");
}

export async function replaySessions(options: ReplayOptions = {}): Promise<ReplayTable> {
	const sessionsDir = options.sessionsDir ?? defaultSessionsDir();
	const cachePath = options.cachePath === undefined ? path.join(path.dirname(sessionsDir), "hashline-replay-cache.json") : options.cachePath;
	let cache: Cache = { version: REPLAY_VERSION, files: {} };
	if (cachePath) {
		try {
			const loaded = JSON.parse(fs.readFileSync(cachePath, "utf8")) as Cache;
			if (loaded?.version === REPLAY_VERSION && loaded.files) cache = loaded;
		} catch {}
	}

	const files = listSessionFiles(sessionsDir);
	const next: Cache = { version: REPLAY_VERSION, files: {} };
	const merged: Record<string, Partial> = {};
	let done = 0;
	let changed = false;
	const queue = [...files];
	await Promise.all(
		Array.from({ length: 6 }, async () => {
			while (queue.length > 0) {
				const file = queue.pop()!;
				let entry: FileEntry | undefined;
				try {
					const st = fs.statSync(file);
					const hit = cache.files[file];
					if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) entry = hit;
					else {
						entry = { size: st.size, mtimeMs: st.mtimeMs, models: await replayFile(file) };
						changed = true;
					}
				} catch {}
				if (entry) next.files[file] = entry;
				options.onProgress?.(++done, files.length);
			}
		}),
	);
	// Merge in a fixed order so the output does not depend on scan timing. Each session is one unit for redraws.
	const units = new Map<string, Partial[]>();
	const addUnit = (models: Record<string, Partial>) => {
		for (const [model, partial] of Object.entries(models)) {
			addPartial((merged[model] ??= emptyPartial()), partial);
			if (!units.has(model)) units.set(model, []);
			units.get(model)!.push(partial);
		}
	};
	for (const file of files) {
		const entry = next.files[file];
		if (entry) addUnit(entry.models);
	}
	// Imported sums (a one-time injection from other machines or archives) are added to the local ones.
	const seedPath = options.seedPath === undefined ? path.join(path.dirname(sessionsDir), "hashline-replay-seed.json") : options.seedPath;
	let seedStamp = "none";
	if (seedPath) {
		try {
			const st = fs.statSync(seedPath);
			seedStamp = `${st.size}:${st.mtimeMs}`;
		} catch {}
	}
	// Nothing scanned anew and the same seed: the table built last time still stands.
	const signature = `${files.length}:${seedStamp}`;
	const sameFiles = !changed && Object.keys(cache.files).length === Object.keys(next.files).length;
	if (sameFiles && cache.built?.signature === signature && cache.built.table.version === REPLAY_VERSION) return cache.built.table;

	const imported: { label: string; files: number }[] = [];
	if (seedPath) {
		try {
			const seed = JSON.parse(fs.readFileSync(seedPath, "utf8")) as ReplaySeed;
			if (seed?.version === REPLAY_VERSION && Array.isArray(seed.sources)) {
				for (const source of seed.sources) {
					imported.push({ label: source.label, files: source.files });
					for (const unit of source.units ?? []) addUnit(unit);
				}
			}
		} catch {}
	}
	const { rows, resultModel } = await buildRows(merged, units);
	const table: ReplayTable = {
		version: REPLAY_VERSION,
		generatedAt: new Date().toISOString(),
		sessionsDir,
		sessionFiles: files.length,
		...(imported.length > 0 ? { imported } : {}),
		resultModel,
		rows,
	};
	if (cachePath) {
		try {
			next.built = { signature, table };
			const tmp = `${cachePath}.tmp-${process.pid}`;
			fs.writeFileSync(tmp, JSON.stringify(next));
			fs.renameSync(tmp, cachePath);
		} catch {}
	}
	return table;
}

/**
 * Scan session files into per-model sums without caching, for building a seed on another machine. Sessions
 * are spread over `groups` units by file name, so the seed stays small but its sessions can still be redrawn.
 * `skip` holds session file names already counted elsewhere; the names seen are added to it.
 */
export async function collectPartials(dir: string, skip = new Set<string>(), groups = 48): Promise<{ files: number; units: Record<string, Partial>[] }> {
	const units: Record<string, Partial>[] = Array.from({ length: groups }, () => ({}));
	let files = 0;
	for (const file of listSessionFiles(dir).sort()) {
		const name = path.basename(file);
		if (skip.has(name)) continue;
		skip.add(name);
		let scanned: Record<string, Partial>;
		try {
			scanned = await replayFile(file);
		} catch {
			continue;
		}
		files++;
		const unit = units[Math.floor(seededRandom(name)() * groups)];
		for (const [model, partial] of Object.entries(scanned)) addPartial((unit[model] ??= emptyPartial()), partial);
	}
	return { files, units: units.filter((u) => Object.keys(u).length > 0) };
}

export function resolveReplayPath(agentDir?: string): string {
	return path.join(agentDir || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi/agent"), "hashline-replay.json");
}

export function saveReplayTable(table: ReplayTable, agentDir?: string): string {
	const file = resolveReplayPath(agentDir);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, JSON.stringify(table, null, 1) + "\n");
	fs.renameSync(tmp, file);
	return file;
}

export function loadReplayTable(agentDir?: string): ReplayTable | undefined {
	try {
		const table = JSON.parse(fs.readFileSync(resolveReplayPath(agentDir), "utf8")) as ReplayTable;
		return table?.version === REPLAY_VERSION && Array.isArray(table.rows) ? table : undefined;
	} catch {
		return undefined;
	}
}
