import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type EditChoice = "hashline" | "replace";

export interface ModelRule {
	/** Case-insensitive glob matched against `provider/id` and bare `id` (e.g. `antigravity/gemini-*`, `*astra*`, `anthropic/*`). */
	match: string;
	use: EditChoice;
	/** Manual per-model override set with Enter in /hashline (cleared with Ctrl+R); wins over every other rule. */
	manual?: boolean;
	note?: string;
}

export interface HashlineConfig {
	version: 1;
	/** Fallback when no rule matches a model. */
	defaultUse: EditChoice;
	rules: ModelRule[];
}

/**
 * Installing the extension changes nothing: every model stays on Pi's built-in edit tool until the user
 * picks hashline for it in `/hashline` (or writes a rule by hand).
 */
export const DEFAULT_CONFIG: HashlineConfig = {
	version: 1,
	defaultUse: "replace",
	rules: [],
};

/**
 * Family rules that earlier versions wrote into every new `hashline.json`. They routed whole model families
 * to hashline without the user asking, so they are dropped on load. A rule the user set in the picker
 * (`manual`) or wrote differently is kept.
 */
const LEGACY_SEEDED_RULES: readonly (readonly [string, EditChoice])[] = [
	["anthropic/*", "replace"],
	["*/claude-*", "replace"],
	["*gemini*", "hashline"],
	["google/*", "hashline"],
	["google-vertex/*", "hashline"],
	["openai/*", "hashline"],
	["openai-codex/*", "hashline"],
	["*spark*", "replace"],
	["kimi*", "replace"],
	["*moonshot*", "replace"],
	["deepseek/*", "replace"],
	["*minimax*", "replace"],
	["*qwen*3.8*", "replace"],
];

function isLegacySeededRule(rule: ModelRule): boolean {
	if ((rule?.manual ?? (rule as any)?.pinned) === true) return false;
	const use = normalizeChoice(rule?.use);
	return LEGACY_SEEDED_RULES.some(([match, legacyUse]) => match === rule?.match && legacyUse === use);
}

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
		return { use: normalizeChoice(config.defaultUse) ?? "replace", source: "no-model" };
	}

	// 1. Manual per-model overrides always win until reset.
	const manualRule = matchBestRule(
		(config.rules ?? []).filter(r => (r.manual ?? (r as any).pinned) === true),
		full,
		id,
	);
	if (manualRule) return { use: manualRule.use, source: `manual:${manualRule.match}` };

	// 2. Rules the user wrote by hand (longest match wins).
	const familyRule = matchBestRule(config.rules ?? [], full, id);
	if (familyRule) return { use: familyRule.use, source: `rule:${familyRule.match}` };

	return { use: normalizeChoice(config.defaultUse) ?? "replace", source: "default" };
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
		const normRules = Array.isArray(parsed.rules)
			? parsed.rules
					.map((r: any) => {
						if (r && typeof r === "object" && r.pinned === true && r.manual === undefined) {
							const { pinned: _legacy, ...rest } = r;
							return { ...rest, manual: true } as ModelRule;
						}
						return r as ModelRule;
					})
					.filter((r) => !isLegacySeededRule(r))
			: [];
		// Keys and family rules written by earlier versions are ignored and dropped on the next save.
		const config: HashlineConfig = {
			version: 1,
			defaultUse: normalizeChoice(parsed.defaultUse) ?? "replace",
			rules: normRules,
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
