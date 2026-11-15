import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type EditChoice = "hashline" | "replace";

export interface ModelRule {
	/** Case-insensitive glob matched against `provider/id` and bare `id` (e.g. `antigravity/gemini-*`, `*astra*`, `anthropic/*`). */
	match: string;
	use: EditChoice;
	/** Manual per-model override set with Enter in /hashline (cleared with Ctrl+R); overrides calibrated verdicts. */
	manual?: boolean;
	note?: string;
}

export interface CalibratedEntry {
	use: EditChoice;
	speedup: number;
	bytesRatio: number;
	passReplace: string;
	passHashline: string;
	replaceEditMs: number;
	hashlineEditMs: number;
	replaceBytes: number;
	hashlineBytes: number;
	apiCalls?: number;
	totalTokens?: number;
	thinking: string;
	reason: string;
	measuredAt: string;
}

export interface HashlineConfig {
	version: 1;
	/** Fallback when neither `calibrated` nor `rules` matches a model. */
	defaultUse: EditChoice;
	/** Minimum edit-turn speedup (`replaceEditMs / hashlineEditMs`) required for `calibrate.mjs` to select `hashline` when both arms pass. */
	minSpeedup: number;
	/** Number of paired repeats per task during calibration (median across repeats reduces single-run jitter; default 2 = 8 1-turn calls). */
	benchRepeats?: number;
	/**
	 * Abort a benchmark if it exceeds `maxBenchCalls`, `maxBenchTokens`, or `benchTimeoutSec`.
	 * Off (`false`) by default so slow or retrying models run to completion unless stopped with Ctrl+B.
	 */
	stopOnOverrun?: boolean;
	/** Optional API-call ceiling per model benchmark when `stopOnOverrun` is true (defaults to 24). */
	maxBenchCalls?: number;
	/** Optional token ceiling per model benchmark when `stopOnOverrun` is true (defaults to 120000). */
	maxBenchTokens?: number;
	/** Optional per-trial timeout in seconds when `stopOnOverrun` is true (defaults to 300). */
	benchTimeoutSec?: number;
	rules: ModelRule[];
	calibrated: Record<string, CalibratedEntry>;
}

export const DEFAULT_CONFIG: HashlineConfig = {
	version: 1,
	defaultUse: "replace",
	minSpeedup: 1.15,
	stopOnOverrun: false,
	rules: [
		{ match: "anthropic/*", use: "replace", note: "Claude is RL-tuned for tight oldText anchors (97.7% success, 1.3x inflation)" },
		{ match: "*/claude-*", use: "replace" },
		{ match: "*gemini*", use: "hashline", note: "Gemini bloats oldText 4x-22x without line bounds" },
		{ match: "google/*", use: "hashline" },
		{ match: "google-vertex/*", use: "hashline" },
		{ match: "openai/*", use: "hashline" },
		{ match: "openai-codex/*", use: "hashline" },
		{ match: "*spark*", use: "replace", note: "omp fallback" },
		{ match: "kimi*", use: "replace", note: "omp fallback unless calibrated faster" },
		{ match: "*moonshot*", use: "replace" },
		{ match: "deepseek/*", use: "replace" },
		{ match: "*minimax*", use: "replace" },
		{ match: "*qwen*3.8*", use: "replace" },
	],
	calibrated: {},
};

export function resolveConfigPath(agentDir?: string): string {
	if (process.env.PI_HASHLINE_CONFIG?.trim()) {
		return path.resolve(process.env.PI_HASHLINE_CONFIG.trim());
	}
	const base = agentDir || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi/agent");
	return path.join(base, "hashline.json");
}

function globToRegExp(glob: string): RegExp {
	const escaped = glob
		.trim()
		.toLowerCase()
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, "i");
}

/** Specificity score: count of non-wildcard characters so `openai-codex/gpt-6-astra` beats `openai-codex/*` beats `*astra*`. */
function specificity(glob: string): number {
	return glob.replace(/[*?]/g, "").length;
}

function normalizeChoice(v: unknown): EditChoice | undefined {
	if (v === "hashline") return "hashline";
	if (v === "replace" || v === "built-in") return "replace";
	return undefined;
}

export function matchBestRule(rules: readonly ModelRule[], fullModel: string, bareId: string): ModelRule | undefined {
	let best: { rule: ModelRule; score: number } | undefined;
	for (const rule of rules) {
		const use = normalizeChoice(rule?.use);
		if (!rule?.match || !use) continue;
		const re = globToRegExp(rule.match);
		const target = rule.match.includes("/") ? fullModel : bareId;
		if (re.test(fullModel) || re.test(target)) {
			const score = specificity(rule.match) + (rule.match.includes("/") ? 100 : 0);
			if (!best || score > best.score) {
				best = { rule: { ...rule, use }, score };
			}
		}
	}
	return best?.rule;
}

export function resolveModelDecision(
	config: HashlineConfig,
	model: { provider?: string; id?: string } | undefined,
): { use: EditChoice; source: string } {
	const provider = (model?.provider ?? "").trim().toLowerCase();
	const id = (model?.id ?? "").trim().toLowerCase();
	const full = provider && id ? `${provider}/${id}` : id || provider;
	if (!full) {
		return { use: config.defaultUse ?? "replace", source: "no-model" };
	}

	// 1. Manual per-model overrides always win until reset.
	const manualRule = matchBestRule(
		(config.rules ?? []).filter(r => (r.manual ?? (r as any).pinned) === true),
		full,
		id,
	);
	if (manualRule) return { use: manualRule.use, source: `manual:${manualRule.match}` };

	// 2. Empirical calibration result for this exact `provider/id` beats default family wildcards.
	const calibrated = config.calibrated?.[full];
	const calUse = normalizeChoice(calibrated?.use);
	if (calibrated && calUse) {
		return { use: calUse, source: `calibrated:${full} (${calibrated.speedup}x)` };
	}

	// 3. Default family/model rules (longest match wins).
	const familyRule = matchBestRule(config.rules ?? [], full, id);
	if (familyRule) return { use: familyRule.use, source: `rule:${familyRule.match}` };

	return { use: config.defaultUse ?? "replace", source: "default" };
}

let cachedFile: { path: string; mtimeMs: number; size: number; config: HashlineConfig } | undefined;

export function loadConfigSync(agentDir?: string, seedIfMissing = true, forceReload = false): HashlineConfig {
	const file = resolveConfigPath(agentDir);
	try {
		const st = fs.statSync(file);
		if (
			!forceReload &&
			cachedFile &&
			cachedFile.path === file &&
			cachedFile.mtimeMs === st.mtimeMs &&
			cachedFile.size === st.size
		) {
			return structuredClone(cachedFile.config);
		}
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<HashlineConfig>;
		const posNum = (v: unknown): number | undefined =>
			typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
		const normRules = Array.isArray(parsed.rules)
			? parsed.rules.map((r: any) => {
					if (r && typeof r === "object" && r.pinned === true && r.manual === undefined) {
						const { pinned: _legacy, ...rest } = r;
						return { ...rest, manual: true } as ModelRule;
					}
					return r as ModelRule;
				})
			: DEFAULT_CONFIG.rules;
		const config: HashlineConfig = {
			version: 1,
			defaultUse: normalizeChoice(parsed.defaultUse) ?? "replace",
	minSpeedup: posNum(parsed.minSpeedup) ?? 1.15,
			...(posNum(parsed.benchRepeats) ? { benchRepeats: Math.round(posNum(parsed.benchRepeats)!) } : {}),
			stopOnOverrun: parsed.stopOnOverrun === true,
			...(posNum(parsed.maxBenchCalls) ? { maxBenchCalls: posNum(parsed.maxBenchCalls) } : {}),
			...(posNum(parsed.maxBenchTokens) ? { maxBenchTokens: posNum(parsed.maxBenchTokens) } : {}),
			...(posNum(parsed.benchTimeoutSec) ? { benchTimeoutSec: posNum(parsed.benchTimeoutSec) } : {}),
			rules: normRules,
			calibrated: parsed.calibrated && typeof parsed.calibrated === "object" ? parsed.calibrated : {},
		};
		cachedFile = { path: file, mtimeMs: st.mtimeMs, size: st.size, config };
		return structuredClone(config);
	} catch {
		const fresh: HashlineConfig = structuredClone(DEFAULT_CONFIG);
		if (seedIfMissing) {
			try {
				saveConfigSync(fresh, agentDir);
			} catch {}
		}
		return fresh;
	}
}

export function saveConfigSync(config: HashlineConfig, agentDir?: string): string {
	const file = resolveConfigPath(agentDir);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
	fs.renameSync(tmp, file);
	try {
		const st = fs.statSync(file);
		cachedFile = { path: file, mtimeMs: st.mtimeMs, size: st.size, config: structuredClone(config) };
	} catch {}
	return file;
}
