import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type EditChoice = "hashline" | "replace";
export type OverrideMode = "auto" | "all" | "force" | "off";

export interface ModelRule {
	/** Case-insensitive glob matched against `provider/id` and bare `id` (e.g. `antigravity/gemini-*`, `*astra*`, `anthropic/*`). */
	match: string;
	use: EditChoice;
	/** Pinned rules override `calibrated` results so hand-edits in hashline.json always win. */
	pinned?: boolean;
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
	rules: ModelRule[];
	calibrated: Record<string, CalibratedEntry>;
}

export const DEFAULT_CONFIG: HashlineConfig = {
	version: 1,
	defaultUse: "replace",
	minSpeedup: 1.15,
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

export function matchBestRule(rules: readonly ModelRule[], fullModel: string, bareId: string): ModelRule | undefined {
	let best: { rule: ModelRule; score: number } | undefined;
	for (const rule of rules) {
		if (!rule?.match || (rule.use !== "hashline" && rule.use !== "replace")) continue;
		const re = globToRegExp(rule.match);
		const target = rule.match.includes("/") ? fullModel : bareId;
		if (re.test(fullModel) || re.test(target)) {
			const score = specificity(rule.match) + (rule.match.includes("/") ? 100 : 0);
			if (!best || score > best.score) {
				best = { rule, score };
			}
		}
	}
	return best?.rule;
}

export function resolveModelDecision(
	config: HashlineConfig,
	overrideMode: OverrideMode,
	model: { provider?: string; id?: string } | undefined,
): { use: EditChoice; source: string } {
	if (overrideMode === "off") return { use: "replace", source: "override:off" };
	if (overrideMode === "force") return { use: "hashline", source: "override:force" };

	const provider = (model?.provider ?? "").trim().toLowerCase();
	const id = (model?.id ?? "").trim().toLowerCase();
	const full = provider && id ? `${provider}/${id}` : id || provider;
	if (!full) {
		return { use: overrideMode === "all" ? "hashline" : config.defaultUse, source: "no-model" };
	}

	// 1. User-pinned rules always win.
	const pinnedRule = matchBestRule(
		(config.rules ?? []).filter(r => r.pinned === true),
		full,
		id,
	);
	if (pinnedRule) return { use: pinnedRule.use, source: `pinned:${pinnedRule.match}` };

	// 2. `overrideMode === "all"` enables hashline on Claude/GPT/Gemini while still respecting explicit non-Claude replace fallbacks unless calibrated faster.
	if (overrideMode === "all") {
		const cal = config.calibrated?.[full];
		if (cal) return { use: cal.use, source: `calibrated:${full}` };
		const rule = matchBestRule(config.rules ?? [], full, id);
		if (rule && rule.use === "replace" && !rule.match.includes("anthropic") && !rule.match.includes("claude")) {
			return { use: "replace", source: `rule:${rule.match}` };
		}
		return { use: "hashline", source: "override:all" };
	}

	// 3. Empirical calibration result for this exact `provider/id` beats unpinned family wildcards.
	const calibrated = config.calibrated?.[full];
	if (calibrated && (calibrated.use === "hashline" || calibrated.use === "replace")) {
		return { use: calibrated.use, source: `calibrated:${full} (${calibrated.speedup}x)` };
	}

	// 4. Unpinned family/model rules (longest match wins).
	const familyRule = matchBestRule(config.rules ?? [], full, id);
	if (familyRule) return { use: familyRule.use, source: `rule:${familyRule.match}` };

	return { use: config.defaultUse ?? "replace", source: "default" };
}

let cachedFile: { path: string; mtimeMs: number; config: HashlineConfig } | undefined;

export function loadConfigSync(agentDir?: string, seedIfMissing = true): HashlineConfig {
	const file = resolveConfigPath(agentDir);
	try {
		const st = fs.statSync(file);
		if (cachedFile && cachedFile.path === file && cachedFile.mtimeMs === st.mtimeMs) {
			return cachedFile.config;
		}
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<HashlineConfig>;
		const config: HashlineConfig = {
			version: 1,
			defaultUse: parsed.defaultUse === "hashline" ? "hashline" : "replace",
			minSpeedup: typeof parsed.minSpeedup === "number" && parsed.minSpeedup > 0 ? parsed.minSpeedup : 1.15,
			rules: Array.isArray(parsed.rules) ? parsed.rules : DEFAULT_CONFIG.rules,
			calibrated: parsed.calibrated && typeof parsed.calibrated === "object" ? parsed.calibrated : {},
		};
		cachedFile = { path: file, mtimeMs: st.mtimeMs, config };
		return config;
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
		cachedFile = { path: file, mtimeMs: st.mtimeMs, config };
	} catch {}
	return file;
}
