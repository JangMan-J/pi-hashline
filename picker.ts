/**
 * Interactive TUI menu for `pi-hashline`, modeled directly on `@jangmanj/pi-picks`
 * (big `●` glyph, semantic colors, facet tabs with `<<`/`>>` windowing, live fuzzy search,
 * stable selection identity, a fixed column header row with Ctrl+S sort cycling, and
 * responsive column dropping that never shifts column x-offsets).
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Input, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	type CalibratedEntry,
	type EditChoice,
	type HashlineConfig,
	loadConfigSync,
	type OverrideMode,
	resolveConfigPath,
	resolveModelDecision,
	saveConfigSync,
} from "./config.ts";

const FREQUENT_TAB = "\0frequent";
const BENCHMARKED_TAB = "\0benchmarked";
const ALL_TAB = "\0all";

const CALIBRATE_SCRIPT = path.resolve(import.meta.dirname, "calibrate.mjs");

export type SortMode = "default" | "uses" | "edit" | "bench" | "model" | "provider";
const SORT_CYCLE: SortMode[] = ["default", "uses", "edit", "bench", "model", "provider"];

type Column = "model" | "provider" | "uses" | "edit" | "bench";
type RightColumn = "uses" | "edit" | "bench";
const RIGHT_ORDER: RightColumn[] = ["uses", "edit", "bench"];
/** Narrow-width drop order: Edit stays longest because toggling it is the primary action. */
const DROP_ORDER: RightColumn[] = ["uses", "bench", "edit"];
const HEADER_LABEL: Record<Column, string> = { model: "Model", provider: "Provider", uses: "Uses", edit: "Edit", bench: "Bench" };
const ARROW: Record<Column, string> = { model: "▲", provider: "▲", uses: "▼", edit: "▲", bench: "▲" };
/** Every possible Edit / Bench cell fits these fixed widths, so toggles and benchmarks never shift columns. */
const EDIT_W = Math.max(visibleWidth("* ● hashline"), visibleWidth("* ○ replace"), visibleWidth("Edit ▲"));
const BENCH_W = Math.max(
	...["⟳ running…", "✗ error", "✓ faster", "✓ keep replace", "untested", "Bench ▲"].map((s) => visibleWidth(s)),
);

type BenchVerdict = "faster" | "keep" | "error" | "untested";
const BENCH_RANK: Record<BenchVerdict, number> = { faster: 0, keep: 1, error: 2, untested: 3 };

interface Layout {
	show: boolean;
	modelW: number;
	provW: number;
	leftAvail: number;
	right: RightColumn[];
	w: Record<RightColumn, number>;
}

interface Cell {
	styled: string;
	w: number;
}

export const modelKey = (m: { provider: string; id: string }): string =>
	`${m.provider.toLowerCase()}/${m.id.toLowerCase()}`;

/** Friendly display name for a provider id — matching pi-picks. */
export function providerLabel(id: string): string {
	return id
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

/** Omit redundant maker prefixes and `(Provider)` suffixes — matching pi-picks. */
export function modelLabel(model: { id: string; name: string; provider: string }): string {
	let name = model.name || model.id;
	const prefix = name.match(/^([^():]+):\s+(?=\S)/);
	if (prefix) {
		const maker = prefix[1]!.toLowerCase().replace(/[\s._-]/g, "");
		const namespace = model.id.includes("/") ? model.id.split("/")[0]! : "";
		if (maker && [model.provider, namespace].some((id) => id.toLowerCase().replace(/[\s._-]/g, "") === maker)) {
			name = name.slice(prefix[0].length);
		}
	}
	const suffix = name.match(/\s+\(([^()]*)\)\s*$/);
	const provider = suffix?.[1]?.trim().toLowerCase();
	return suffix &&
		(provider === model.provider.toLowerCase() || provider === providerLabel(model.provider).toLowerCase())
		? name.slice(0, suffix.index).trimEnd() || name
		: name;
}

/** Sanitize untrusted strings before rendering to terminal cells. */
function cleanCellText(s: string): string {
	return s.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

function padCell(cell: Cell, width: number, align: "left" | "right"): string {
	const fill = " ".repeat(Math.max(0, width - cell.w));
	return align === "left" ? cell.styled + fill : fill + cell.styled;
}

/** Plain-language provenance for a routing decision (no raw speedup multipliers). */
export function describeDecision(dec: { use: EditChoice; source: string }): string {
	const [kind, ...rest] = dec.source.split(":");
	const detail = rest.join(":");
	switch (kind) {
		case "pinned":
			return `pinned → ${dec.use}`;
		case "calibrated":
			return dec.use === "hashline" ? "benchmarked → faster (hashline)" : "benchmarked → keep replace";
		case "rule": {
			const short = detail.replace(/\*/g, "").replace(/^\/+|\/+$/g, "") || detail;
			return `rule (${short}) → ${dec.use}`;
		}
		case "override":
			return `mode ${detail} → ${dec.use}`;
		default:
			return `default → ${dec.use}`;
	}
}

export interface UsageSnapshot {
	/** `provider/id` (lowercased) -> number of distinct real user sessions using that model. */
	counts: Map<string, number>;
	/** `provider/id` (lowercased) entries from `settings.json` `pi-picks.favorites`. */
	favorites: Set<string>;
}

/** Fast (~45 ms) header scan of real user sessions + `pi-picks.favorites` to rank frequently used models first. */
export function scanModelUsage(agentDir = getAgentDir()): UsageSnapshot {
	const counts = new Map<string, number>();
	const favorites = new Set<string>();

	try {
		const settingsRaw = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
		const favList = settingsRaw?.["pi-picks"]?.favorites;
		if (Array.isArray(favList)) {
			for (const item of favList) {
				if (typeof item === "string" && item.includes("/")) {
					favorites.add(item.trim().toLowerCase());
				}
			}
		}
	} catch {}

	const sessionsRoot = path.join(agentDir, "sessions");
	try {
		const dirs = fs.readdirSync(sessionsRoot, { withFileTypes: true });
		const buf = Buffer.allocUnsafe(4096);
		for (const dir of dirs) {
			if (!dir.isDirectory()) continue;
			// Skip synthetic benchmark temp directories (`--tmp--`, `--var-tmp--`) so user history isn't skewed.
			if (/^--(?:var-)?tmp(?:-|$)/.test(dir.name)) continue;
			const dp = path.join(sessionsRoot, dir.name);
			let files: string[];
			try {
				files = fs.readdirSync(dp);
			} catch {
				continue;
			}
			for (const f of files) {
				if (!f.endsWith(".jsonl")) continue;
				let fd = -1;
				try {
					fd = fs.openSync(path.join(dp, f), "r");
					const n = fs.readSync(fd, buf, 0, buf.length, 0);
					const head = buf.subarray(0, n).toString("utf8");
					const seen = new Set<string>();
					for (const m of head.matchAll(/"provider":"([^"]+)","(?:modelId|model)":"([^"]+)"/g)) {
						const k = `${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}`;
						if (!seen.has(k)) {
							seen.add(k);
							counts.set(k, (counts.get(k) ?? 0) + 1);
						}
					}
				} catch {
				} finally {
					if (fd >= 0) {
						try {
							fs.closeSync(fd);
						} catch {}
					}
				}
			}
		}
	} catch {}

	return { counts, favorites };
}

export interface BenchJobState {
	startedAt: number;
	gen: number;
	proc?: ChildProcess;
}

export interface PickerCallbacks {
	allModels: Model<Api>[];
	currentModel: Model<Api> | undefined;
	usage: UsageSnapshot;
	config: HashlineConfig;
	overrideMode: OverrideMode;
	runningJobs: Map<string, BenchJobState>;
	lastBenchErrors: Map<string, string>;
	now?: () => number;
	onToggleModel: (model: Model<Api>, nextUse: EditChoice) => HashlineConfig;
	onUnpinModel: (model: Model<Api>) => HashlineConfig;
	onCycleOverrideMode: () => OverrideMode;
	onToggleBenchmark: (model: Model<Api>) => void;
	onClose: () => void;
}

export class HashlinePickerComponent {
	focused = false;

	private categories: string[] = [];
	private byCategory = new Map<string, Model<Api>[]>();
	private allSorted: Model<Api>[] = [];
	private frequentSorted: Model<Api>[] = [];
	private benchmarkedSorted: Model<Api>[] = [];

	private catIndex = 0;
	private providerLo = 0;
	private rowIndex = 0;
	private selectedKey: string | undefined;
	private sort: SortMode = "default";

	private searchInput: Input;
	private filteredRows: Model<Api>[] = [];
	private globalMatches: Model<Api>[] = [];
	private matchingProviders = new Set<string>();

	constructor(private opts: PickerCallbacks) {
		this.searchInput = new Input();
		this.searchInput.focused = true;
		this.searchInput.onEscape = () => opts.onClose();
		this.searchInput.onSubmit = () => {
			this.swapSelected();
		};

		this.rebuildLists();
		// Open on Frequent when user has session history/favorites/calibrated entries; otherwise All.
		this.catIndex = this.frequentSorted.length > 0 ? 0 : this.tabs.indexOf(ALL_TAB);
		if (opts.currentModel) {
			this.selectedKey = modelKey(opts.currentModel);
		}
		this.applyFilter();
	}

	set focusedState(v: boolean) {
		this.focused = v;
		this.searchInput.focused = v;
	}

	/** Active sort mode (`provider` collapses to `default` on single-provider tabs). */
	get sortMode(): SortMode {
		return this.sort === "provider" && !this.crossProvider ? "default" : this.sort;
	}

	private get tabs(): string[] {
		return [FREQUENT_TAB, BENCHMARKED_TAB, ALL_TAB, ...this.categories];
	}

	private currentTab(): string {
		return this.tabs[this.catIndex] ?? FREQUENT_TAB;
	}

	private get crossProvider(): boolean {
		const tab = this.currentTab();
		return tab === FREQUENT_TAB || tab === BENCHMARKED_TAB || tab === ALL_TAB;
	}

	private tabLabel(key: string): string {
		if (key === FREQUENT_TAB) return "Frequent";
		if (key === BENCHMARKED_TAB) return "Benchmarked";
		if (key === ALL_TAB) return "All";
		return providerLabel(key);
	}

	private tabSource(key: string): Model<Api>[] {
		if (key === FREQUENT_TAB) return this.frequentSorted;
		if (key === BENCHMARKED_TAB) return this.benchmarkedSorted;
		if (key === ALL_TAB) return this.allSorted;
		return this.byCategory.get(key) ?? [];
	}

	private usageCount(m: Model<Api>): number {
		return this.opts.usage.counts.get(modelKey(m)) ?? 0;
	}

	private isFavorite(m: Model<Api>): boolean {
		return this.opts.usage.favorites.has(modelKey(m));
	}

	private isCurrent(m: Model<Api>): boolean {
		const cur = this.opts.currentModel;
		return Boolean(cur && cur.id === m.id && cur.provider === m.provider);
	}

	private calibratedOf(m: Model<Api>): CalibratedEntry | undefined {
		return this.opts.config.calibrated?.[modelKey(m)];
	}

	private isPinned(m: Model<Api>): boolean {
		const key = modelKey(m);
		return (this.opts.config.rules ?? []).some((r) => r.pinned === true && r.match.toLowerCase() === key);
	}

	private decisionOf(m: Model<Api>): { use: EditChoice; source: string } {
		return resolveModelDecision(this.opts.config, this.opts.overrideMode, m);
	}

	/** Bench verdict ignoring a running job, so starting Ctrl+B never reorders rows. */
	private benchVerdict(m: Model<Api>): BenchVerdict {
		if (this.opts.lastBenchErrors.has(modelKey(m))) return "error";
		const cal = this.calibratedOf(m);
		if (!cal) return "untested";
		const pass = /^(\d+)\/(\d+)$/.exec(String(cal.passHashline ?? ""));
		if (pass && Number(pass[1]) === 0) return "error";
		return cal.use === "hashline" ? "faster" : "keep";
	}

	syncState(patch: {
		allModels?: Model<Api>[];
		currentModel?: Model<Api>;
		config?: HashlineConfig;
		overrideMode?: OverrideMode;
	}): void {
		const prevTab = this.currentTab();
		if (patch.allModels !== undefined) this.opts.allModels = patch.allModels;
		if (patch.currentModel !== undefined) this.opts.currentModel = patch.currentModel;
		if (patch.config !== undefined) this.opts.config = patch.config;
		if (patch.overrideMode !== undefined) this.opts.overrideMode = patch.overrideMode;
		this.rebuildLists();
		const idx = this.tabs.indexOf(prevTab);
		this.catIndex = idx >= 0 ? idx : 0;
		this.applyFilter();
	}

	private byModel = (a: Model<Api>, b: Model<Api>): number =>
		modelLabel(a).localeCompare(modelLabel(b)) || a.id.localeCompare(b.id);

	private byProvider = (a: Model<Api>, b: Model<Api>): number =>
		providerLabel(a.provider).localeCompare(providerLabel(b.provider));

	private rebuildLists(): void {
		const map = new Map<string, Model<Api>[]>();
		for (const m of this.opts.allModels) {
			if (!map.has(m.provider)) map.set(m.provider, []);
			map.get(m.provider)!.push(m);
		}
		this.byCategory = new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
		this.categories = Array.from(this.byCategory.keys());
		this.allSorted = [...map.values()].flat().sort((a, b) => this.byModel(a, b) || this.byProvider(a, b));
		this.frequentSorted = this.allSorted.filter(
			(m) =>
				this.isCurrent(m) ||
				this.isFavorite(m) ||
				this.usageCount(m) > 0 ||
				this.calibratedOf(m) !== undefined ||
				this.isPinned(m),
		);
		this.benchmarkedSorted = this.allSorted.filter(
			(m) => this.calibratedOf(m) !== undefined || this.opts.runningJobs.has(modelKey(m)),
		);
	}

	private sortRows(rows: Model<Api>[]): Model<Api>[] {
		const mode = this.sortMode;
		const byUses = (a: Model<Api>, b: Model<Api>) =>
			this.usageCount(b) - this.usageCount(a) ||
			Number(this.isFavorite(b)) - Number(this.isFavorite(a)) ||
			this.byModel(a, b) ||
			this.byProvider(a, b);
		const byModelProv = (a: Model<Api>, b: Model<Api>) => this.byModel(a, b) || this.byProvider(a, b);
		let cmp: (a: Model<Api>, b: Model<Api>) => number;
		switch (mode) {
			case "uses":
				cmp = byUses;
				break;
			case "edit":
				cmp = (a, b) => {
					const da = this.decisionOf(a);
					const db = this.decisionOf(b);
					return (
						Number(db.use === "hashline") - Number(da.use === "hashline") ||
						Number(db.source.startsWith("pinned:")) - Number(da.source.startsWith("pinned:")) ||
						byModelProv(a, b)
					);
				};
				break;
			case "bench":
				cmp = (a, b) => BENCH_RANK[this.benchVerdict(a)] - BENCH_RANK[this.benchVerdict(b)] || byModelProv(a, b);
				break;
			case "model":
				cmp = byModelProv;
				break;
			case "provider":
				cmp = (a, b) => this.byProvider(a, b) || this.byModel(a, b);
				break;
			default:
				if (this.currentTab() === FREQUENT_TAB) cmp = byUses;
				else if (this.crossProvider) cmp = byModelProv;
				else cmp = (a, b) => Number(this.isCurrent(b)) - Number(this.isCurrent(a)) || byModelProv(a, b);
		}
		return [...rows].sort(cmp);
	}

	private activeSortColumn(): Column {
		const mode = this.sortMode;
		if (mode === "default") return this.currentTab() === FREQUENT_TAB ? "uses" : "model";
		return mode;
	}

	private applyFilter(): void {
		const query = this.searchInput.getValue().trim();
		const searchText = (m: Model<Api>) =>
			`${m.name} ${m.id} ${m.provider} ${this.decisionOf(m).use} ${this.calibratedOf(m) ? "benchmarked" : "untested"}`;
		this.globalMatches = fuzzyFilter(this.allSorted, query, searchText);
		this.filteredRows = fuzzyFilter(this.sortRows(this.tabSource(this.currentTab())), query, searchText);
		this.matchingProviders = new Set(this.globalMatches.map((m) => m.provider));

		if (this.selectedKey) {
			const idx = this.filteredRows.findIndex((m) => modelKey(m) === this.selectedKey);
			if (idx >= 0) {
				this.rowIndex = idx;
				return;
			}
		}
		this.rowIndex = Math.max(0, Math.min(this.rowIndex, this.filteredRows.length - 1));
		this.selectedKey = this.filteredRows[this.rowIndex] ? modelKey(this.filteredRows[this.rowIndex]!) : undefined;
	}

	private cycleSort(): void {
		let idx = SORT_CYCLE.indexOf(this.sortMode);
		do {
			idx = (idx + 1) % SORT_CYCLE.length;
		} while (SORT_CYCLE[idx] === "provider" && !this.crossProvider);
		this.sort = SORT_CYCLE[idx]!;
		const sel = this.filteredRows[this.rowIndex];
		if (sel) this.selectedKey = modelKey(sel);
		this.applyFilter();
	}

	private switchCategory(delta: number): void {
		const tabs = this.tabs;
		const query = this.searchInput.getValue().trim();
		const anyFreq = this.globalMatches.some((m) => this.frequentSorted.some((f) => modelKey(f) === modelKey(m)));
		const anyBench = this.globalMatches.some((m) => this.benchmarkedSorted.some((b) => modelKey(b) === modelKey(m)));
		const visitable = tabs.filter((tab) => {
			if (!query) return true;
			if (tab === ALL_TAB) return true;
			if (tab === FREQUENT_TAB) return anyFreq || this.currentTab() === FREQUENT_TAB;
			if (tab === BENCHMARKED_TAB) return anyBench || this.currentTab() === BENCHMARKED_TAB;
			return this.matchingProviders.has(tab);
		});
		if (!visitable.length) return;
		let idx = this.catIndex;
		for (let step = 0; step < tabs.length; step++) {
			idx = (idx + delta + tabs.length) % tabs.length;
			if (visitable.includes(tabs[idx]!)) break;
		}
		this.catIndex = idx;
		this.applyFilter();
	}

	private swapSelected(): void {
		const sel = this.filteredRows[this.rowIndex];
		if (!sel) return;
		this.selectedKey = modelKey(sel);
		const cur = this.decisionOf(sel).use;
		const next: EditChoice = cur === "hashline" ? "replace" : "hashline";
		this.opts.config = this.opts.onToggleModel(sel, next);
		this.rebuildLists();
		this.applyFilter();
	}

	private unpinSelected(): void {
		const sel = this.filteredRows[this.rowIndex];
		if (!sel) return;
		this.selectedKey = modelKey(sel);
		this.opts.config = this.opts.onUnpinModel(sel);
		this.rebuildLists();
		this.applyFilter();
	}

	private moveTo(idx: number): void {
		if (!this.filteredRows.length) return;
		this.rowIndex = idx;
		this.selectedKey = modelKey(this.filteredRows[this.rowIndex]!);
	}

	handleInput(data: string): void {
		const n = this.filteredRows.length;
		if (matchesKey(data, Key.ctrl("b"))) {
			const sel = this.filteredRows[this.rowIndex];
			if (sel) {
				this.selectedKey = modelKey(sel);
				this.opts.onToggleBenchmark(sel);
				this.rebuildLists();
				this.applyFilter();
			}
			return;
		}
		if (matchesKey(data, Key.ctrl("s"))) {
			this.cycleSort();
			return;
		}
		if (matchesKey(data, Key.ctrl("u"))) {
			this.unpinSelected();
			return;
		}
		if (matchesKey(data, Key.ctrl("o"))) {
			this.opts.overrideMode = this.opts.onCycleOverrideMode();
			this.applyFilter();
			return;
		}
		// Ctrl+G is Zellij's unlock key: swallow it so it never changes picker state.
		if (matchesKey(data, Key.ctrl("g"))) return;
		if (matchesKey(data, Key.tab)) return this.switchCategory(1);
		if (matchesKey(data, Key.shift("tab"))) return this.switchCategory(-1);
		if (matchesKey(data, Key.shift("up"))) return this.moveTo(Math.max(0, this.rowIndex - 10));
		if (matchesKey(data, Key.shift("down"))) return this.moveTo(Math.max(0, Math.min(n - 1, this.rowIndex + 10)));
		if (matchesKey(data, Key.up)) return this.moveTo(this.rowIndex === 0 ? n - 1 : this.rowIndex - 1);
		if (matchesKey(data, Key.down)) return this.moveTo(this.rowIndex === n - 1 ? 0 : this.rowIndex + 1);
		if (matchesKey(data, Key.left) && this.searchInput.getValue() === "") return this.switchCategory(-1);
		if (matchesKey(data, Key.right) && this.searchInput.getValue() === "") return this.switchCategory(1);

		const before = this.searchInput.getValue();
		this.searchInput.handleInput(data);
		const after = this.searchInput.getValue();
		if (before !== after) {
			this.rowIndex = 0;
			this.selectedKey = undefined;
			this.applyFilter();
		}
	}

	/** Column widths measured over every row of the active tab plus headers-with-arrow and fixed Edit/Bench widths. */
	private layout(width: number): Layout {
		const rows = this.tabSource(this.currentTab());
		const show = this.crossProvider;
		const hw = (c: Column) => visibleWidth(`${HEADER_LABEL[c]} ${ARROW[c]}`);
		const model = Math.max(hw("model"), ...rows.map((m) => visibleWidth(cleanCellText(modelLabel(m))) + 2));
		const provider = show
			? Math.max(hw("provider"), ...rows.map((m) => visibleWidth(`[${cleanCellText(providerLabel(m.provider))}]`)))
			: 0;
		const w: Record<RightColumn, number> = {
			uses: Math.max(hw("uses"), ...rows.map((m) => visibleWidth(this.fmtUses(m)))),
			edit: EDIT_W,
			bench: BENCH_W,
		};
		const right = [...RIGHT_ORDER];
		const rightW = () => right.reduce((s, k) => s + 2 + w[k], 0);
		const leftMin = 2 + Math.min(model, 12) + (show ? 2 + Math.min(provider, 8) : 0);
		for (const col of DROP_ORDER) {
			if (leftMin + rightW() <= width) break;
			right.splice(right.indexOf(col), 1);
		}
		const leftAvail = Math.max(0, width - rightW());
		let modelW = model;
		let provW = provider;
		let over = 2 + modelW + (show ? 2 + provW : 0) - leftAvail;
		const shrink = (cur: number, floor: number): number => {
			const d = Math.min(over, Math.max(0, cur - floor));
			over -= d;
			return cur - d;
		};
		if (over > 0) modelW = shrink(modelW, 18);
		if (over > 0 && show) provW = shrink(provW, 8);
		if (over > 0) modelW = shrink(modelW, 4);
		return { show, modelW, provW, leftAvail, right, w };
	}

	/** Compose a header or data row from per-column cells; headers and rows share this exact geometry. */
	private compose(L: Layout, prefix: Cell, cells: Record<Column, Cell>): string {
		let out = prefix.styled + padCell(cells.model, L.modelW, "left");
		let used = prefix.w + L.modelW;
		if (L.show) {
			out += "  " + padCell(cells.provider, L.provW, "left");
			used += 2 + L.provW;
		}
		out += " ".repeat(Math.max(0, L.leftAvail - used));
		for (const k of L.right) out += "  " + padCell(cells[k], L.w[k], "right");
		return out;
	}

	private renderHeader(L: Layout, theme: any): string {
		const hasQuery = this.searchInput.getValue().trim() !== "";
		const active = hasQuery ? undefined : this.activeSortColumn();
		const cell = (c: Column, maxW: number): Cell => {
			const isActive = c === active;
			const plain = isActive ? `${HEADER_LABEL[c]} ${ARROW[c]}` : HEADER_LABEL[c];
			const text = truncateToWidth(plain, Math.max(1, maxW), "");
			const styled = isActive ? theme.bold(theme.fg("accent", text)) : theme.fg("dim", text);
			// Inactive labels reserve the arrow slot so label x-offsets never move when the sort changes.
			const slot = visibleWidth(` ${ARROW[c]}`);
			const fill = isActive ? 0 : Math.min(slot, Math.max(0, maxW - visibleWidth(text)));
			return { styled: styled + " ".repeat(fill), w: visibleWidth(text) + fill };
		};
		return this.compose(L, { styled: "  ", w: 2 }, {
			model: cell("model", L.modelW),
			provider: cell("provider", L.provW),
			uses: cell("uses", L.w.uses),
			edit: cell("edit", L.w.edit),
			bench: cell("bench", L.w.bench),
		});
	}

	render(width: number, theme: any): string[] {
		if (width < 28) {
			return [
				theme.fg("warning", truncateToWidth("Terminal too narrow for /hashline", Math.max(1, width))),
				theme.fg("dim", truncateToWidth("Esc: close", Math.max(1, width))),
			];
		}

		const benchCount = Object.keys(this.opts.config.calibrated ?? {}).length;
		const runningCount = this.opts.runningJobs.size;
		const headerTitle = "  Hashline Edit Routing";
		const modeBadge = `mode: ${this.opts.overrideMode} · ${benchCount} benchmarked${runningCount > 0 ? ` · ${runningCount} running` : ""}  `;
		const headerGap = Math.max(1, width - visibleWidth(headerTitle) - visibleWidth(modeBadge));
		const headerLine =
			visibleWidth(headerTitle) + visibleWidth(modeBadge) + 1 <= width
				? theme.fg("accent", theme.bold(headerTitle)) +
					" ".repeat(headerGap) +
					theme.fg(runningCount > 0 ? "warning" : "muted", modeBadge)
				: truncateToWidth(theme.fg("accent", theme.bold(headerTitle)), width);

		const lines: string[] = [
			theme.fg("accent", "─".repeat(width)),
			headerLine,
			theme.fg("border", "─".repeat(width)),
			this.renderTabs(width, theme),
			theme.fg("border", "─".repeat(width)),
		];

		// Search input
		const promptText = "  Search: ";
		const promptW = visibleWidth(promptText);
		const inputLines = this.searchInput.render(Math.max(0, width - promptW));
		lines.push(theme.fg("muted", promptText) + (inputLines[0] ?? ""));

		// Column header row (replaces the old blank spacer, so picker height is unchanged)
		const L = this.layout(width);
		lines.push(this.renderHeader(L, theme));

		// Model rows
		const MAX_VISIBLE = 10;
		const half = Math.floor(MAX_VISIBLE / 2);
		const rows = this.filteredRows;
		const hasQuery = this.searchInput.getValue().trim() !== "";
		const start = Math.max(0, Math.min(this.rowIndex - half, rows.length - MAX_VISIBLE));
		const visible = rows.slice(start, start + MAX_VISIBLE);

		if (rows.length === 0) {
			const query = cleanCellText(this.searchInput.getValue().trim());
			const tab = this.currentTab();
			let msg: string;
			if (query && tab !== ALL_TAB && this.globalMatches.length > 0) {
				msg = `  No ${this.tabLabel(tab)} models match "${query}" — Tab to search all ${this.allSorted.length} models`;
			} else if (query) {
				msg = `  No models match "${query}"`;
			} else if (tab === BENCHMARKED_TAB) {
				msg = "  No benchmarked models yet — press Ctrl+B on any model to run the 2-task benchmark";
			} else {
				msg = "  No models in this tab";
			}
			lines.push(theme.fg("muted", truncateToWidth(msg, width)));
		} else {
			for (let i = 0; i < visible.length; i++) {
				const model = visible[i]!;
				const absIdx = start + i;
				const fuzzyHighlight = hasQuery ? (absIdx === 0 ? "top" : "match") : undefined;
				lines.push(this.renderRow(model, absIdx === this.rowIndex, this.isCurrent(model), L, theme, fuzzyHighlight));
			}
		}

		for (let i = Math.max(1, visible.length); i < MAX_VISIBLE; i++) lines.push("");

		// Status/provenance line (1 fixed line so height never jumps)
		const position = rows.length ? this.rowIndex + 1 : 0;
		const selected = rows[this.rowIndex];
		let detailLine = `  (${position}/${rows.length})`;
		if (selected) {
			const err = this.opts.lastBenchErrors.get(modelKey(selected));
			detailLine += ` ${cleanCellText(`${selected.provider}/${selected.id}`)} · ${describeDecision(this.decisionOf(selected))}`;
			if (err) detailLine += ` · err: ${cleanCellText(err)}`;
		}
		const legend = "  ● hashline  ● pinned/running";
		const detailGap = width - visibleWidth(detailLine) - visibleWidth(legend);
		if (detailGap >= 2) {
			lines.push(
				theme.fg("dim", detailLine) +
					" ".repeat(detailGap) +
					theme.fg("success", "  ●") +
					theme.fg("dim", " hashline  ") +
					theme.fg("warning", "●") +
					theme.fg("dim", " pinned/running"),
			);
		} else {
			lines.push(theme.fg("dim", truncateToWidth(detailLine, width)));
		}

		// Help bar
		lines.push(theme.fg("border", "─".repeat(width)));
		const help = "Enter swap · Ctrl+S sort · Ctrl+B bench · Ctrl+U unpin · Ctrl+O mode · Tab tabs · Esc close";
		lines.push(theme.fg("dim", truncateToWidth("  " + help, width, "…")));
		lines.push(theme.fg("accent", "─".repeat(width)));

		return lines.map((l) => truncateToWidth(l, width));
	}

	private fmtUses(m: Model<Api>): string {
		const n = this.usageCount(m);
		const count = n > 0 ? String(n) : "—";
		return this.isFavorite(m) ? `★ ${count}` : count;
	}

	private editCell(m: Model<Api>, theme: any, bold: (s: string) => string): Cell {
		if (this.opts.overrideMode === "off") return { styled: theme.fg("muted", bold("○ off")), w: visibleWidth("○ off") };
		const dec = this.decisionOf(m);
		const pinned = dec.source.startsWith("pinned:");
		const body = dec.use === "hashline" ? "● hashline" : "○ replace";
		const styled = theme.fg(dec.use === "hashline" ? "success" : "muted", bold(body));
		return pinned
			? { styled: theme.fg("warning", bold("*")) + " " + styled, w: visibleWidth(`* ${body}`) }
			: { styled, w: visibleWidth(body) };
	}

	private benchCell(m: Model<Api>, theme: any, bold: (s: string) => string): Cell {
		const mk = (text: string, color: string): Cell => ({ styled: theme.fg(color, bold(text)), w: visibleWidth(text) });
		if (this.opts.runningJobs.has(modelKey(m))) return mk("⟳ running…", "warning");
		switch (this.benchVerdict(m)) {
			case "error":
				return mk("✗ error", "error");
			case "faster":
				return mk("✓ faster", "success");
			case "keep":
				return mk("✓ keep replace", "muted");
			default:
				return mk("untested", "dim");
		}
	}

	private renderTabs(width: number, theme: any): string {
		const activeKey = this.currentTab();
		const hasQuery = this.searchInput.getValue().trim() !== "";
		const freqKeys = new Set(this.frequentSorted.map(modelKey));
		const benchKeys = new Set(this.benchmarkedSorted.map(modelKey));
		const anyFreqMatch = this.globalMatches.some((m) => freqKeys.has(modelKey(m)));
		const anyBenchMatch = this.globalMatches.some((m) => benchKeys.has(modelKey(m)));

		const SEP = theme.fg("dim", "│");
		const SEP_W = 1;
		const labelOf = (key: string) => ` ${this.tabLabel(key)} `;
		const segment = (key: string): string => {
			const label = labelOf(key);
			const selected = key === activeKey;
			const matches =
				key === FREQUENT_TAB
					? anyFreqMatch
					: key === BENCHMARKED_TAB
						? anyBenchMatch
						: key === ALL_TAB
							? this.globalMatches.length > 0
							: this.matchingProviders.has(key);
			const color = selected ? "accent" : hasQuery ? (matches ? "success" : "dim") : "muted";
			const styled = theme.fg(color, selected ? theme.bold(label) : label);
			if (selected) return theme.bg("selectedBg", styled);
			return hasQuery && matches ? theme.bg("customMessageBg", styled) : styled;
		};

		const pinned = [FREQUENT_TAB, BENCHMARKED_TAB, ALL_TAB];
		const pinnedPart = pinned.map(segment).join(SEP);
		const pinnedW = pinned.reduce((sum, key) => sum + visibleWidth(labelOf(key)), 0) + (pinned.length - 1) * SEP_W;
		const providers = this.categories;
		if (!providers.length || width - 2 - pinnedW < 14) {
			return truncateToWidth("  " + pinnedPart, width);
		}

		const segW = providers.map((key) => visibleWidth(labelOf(key)));
		const rangeW = (lo: number, hi: number) =>
			segW.slice(lo, hi + 1).reduce((sum, w) => sum + w, 0) + Math.max(0, hi - lo) * SEP_W;
		const activeIdx = providers.indexOf(activeKey);
		let lo = 0;
		let hi = -1;
		for (let pass = 0; pass < 2; pass++) {
			const leftHidden = lo;
			const rightHidden = providers.length - 1 - hi;
			const reserve =
				(pass === 0 ? 3 : leftHidden > 0 ? visibleWidth("<< ") : 0) +
				(pass === 0 ? 3 : rightHidden > 0 ? visibleWidth(" >>") : 0);
			const avail = Math.max(0, width - 2 - pinnedW - SEP_W - reserve);
			lo = Math.min(Math.max(0, this.providerLo), providers.length - 1);
			if (activeIdx >= 0) {
				if (activeIdx < lo) lo = activeIdx;
				while (lo < activeIdx && rangeW(lo, activeIdx) > avail) lo++;
			}
			hi = lo - 1;
			while (hi + 1 < providers.length && rangeW(lo, hi + 1) <= avail) hi++;
			if (hi < lo) hi = lo;
			while (lo > 0 && rangeW(lo - 1, hi) <= avail) lo--;
		}
		this.providerLo = lo;

		const leftPart = lo > 0 ? theme.fg("dim", "<< ") : "";
		const rightPart = providers.length - 1 - hi > 0 ? theme.fg("dim", " >>") : "";
		const providerPart = providers.slice(lo, hi + 1).map(segment).join(SEP);
		return truncateToWidth("  " + pinnedPart + SEP + leftPart + providerPart + rightPart, width);
	}

	private renderRow(
		model: Model<Api>,
		isSelected: boolean,
		isCurrent: boolean,
		L: Layout,
		theme: any,
		fuzzyHighlight?: "match" | "top",
	): string {
		const bold = (s: string) => (isSelected ? theme.bold(s) : s);
		const dec = this.decisionOf(model);
		const pinned = dec.source.startsWith("pinned:");
		const running = this.opts.runningJobs.has(modelKey(model));
		// Big dot glyph after the model name: gold when pinned/running, green for hashline, dim for replace/off.
		const dotColor = pinned || running ? "warning" : dec.use === "hashline" ? "success" : "dim";
		const rowColor = isSelected ? "accent" : isCurrent ? "success" : "text";
		const sideColor = isSelected ? "accent" : isCurrent ? "success" : "muted";

		const name = truncateToWidth(cleanCellText(modelLabel(model)), Math.max(1, L.modelW - 2), "…");
		const modelCell: Cell = {
			styled: theme.fg(rowColor, name) + theme.fg(dotColor, theme.bold(" ●")),
			w: visibleWidth(name) + 2,
		};
		const provText = L.show ? truncateToWidth(`[${cleanCellText(providerLabel(model.provider))}]`, L.provW, "…") : "";
		const fav = this.isFavorite(model);
		const usesText = this.fmtUses(model);
		const countText = fav ? usesText.slice(2) : usesText;
		const usesCell: Cell = {
			styled: (fav ? theme.fg("warning", "★ ") : "") + theme.fg(isSelected ? "accent" : "dim", countText),
			w: visibleWidth(usesText),
		};

		const line = this.compose(L, { styled: theme.fg(rowColor, isSelected ? "▶ " : "  "), w: 2 }, {
			model: modelCell,
			provider: { styled: theme.fg(sideColor, provText), w: visibleWidth(provText) },
			uses: usesCell,
			edit: this.editCell(model, theme, bold),
			bench: this.benchCell(model, theme, bold),
		});
		const fuzzyBg =
			fuzzyHighlight === "top" ? "searchMatchBg" : fuzzyHighlight === "match" ? "toolPendingBg" : undefined;
		return fuzzyBg ? theme.bg(fuzzyBg, line) : line;
	}

	invalidate(): void {
		this.searchInput.invalidate();
	}
}

export interface OpenHashlineMenuOptions {
	ctx: ExtensionContext;
	getOverrideMode: () => OverrideMode;
	setOverrideMode: (m: OverrideMode) => void;
	runningJobs: Map<string, BenchJobState>;
	lastBenchErrors: Map<string, string>;
}

export async function openHashlineMenu(opts: OpenHashlineMenuOptions): Promise<void> {
	const { ctx, getOverrideMode, setOverrideMode, runningJobs, lastBenchErrors } = opts;
	const agentDir = getAgentDir();

	const refreshPromise = Promise.resolve(ctx.modelRegistry.refresh());
	let allModels = ctx.modelRegistry.getAvailable();
	if (allModels.length === 0) {
		await refreshPromise.catch(() => {});
		allModels = ctx.modelRegistry.getAvailable();
	}
	if (allModels.length === 0) {
		ctx.ui.notify("No models available", "warning");
		return;
	}

	const usage = scanModelUsage(agentDir);
	let config = loadConfigSync(agentDir);

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		let closed = false;
		let jobSeq = 0;

		let picker: HashlinePickerComponent;

		const tick = setInterval(() => {
			if (!closed && runningJobs.size > 0) {
				tui.requestRender();
			}
		}, 1000);
		tick.unref?.();

		const close = () => {
			if (closed) return;
			closed = true;
			clearInterval(tick);
			done();
		};

		const toggleModel = (model: Model<Api>, nextUse: EditChoice): HashlineConfig => {
			const key = modelKey(model);
			const fresh = loadConfigSync(agentDir);
			fresh.rules = (fresh.rules ?? []).filter((r) => !(r.pinned && r.match.toLowerCase() === key));
			fresh.rules.unshift({ match: key, use: nextUse, pinned: true, note: "pinned in /hashline menu" });
			saveConfigSync(fresh, agentDir);
			config = fresh;
			return fresh;
		};

		const unpinModel = (model: Model<Api>): HashlineConfig => {
			const key = modelKey(model);
			const fresh = loadConfigSync(agentDir);
			fresh.rules = (fresh.rules ?? []).filter((r) => !(r.pinned && r.match.toLowerCase() === key));
			saveConfigSync(fresh, agentDir);
			config = fresh;
			return fresh;
		};

		const cycleMode = (): OverrideMode => {
			const order: OverrideMode[] = ["auto", "all", "force", "off"];
			const next = order[(order.indexOf(getOverrideMode()) + 1) % order.length]!;
			setOverrideMode(next);
			return next;
		};

		const toggleBenchmark = (model: Model<Api>) => {
			const key = modelKey(model);
			const existing = runningJobs.get(key);
			if (existing) {
				try {
					if (existing.proc?.pid) process.kill(-existing.proc.pid, "SIGTERM");
				} catch {}
				try {
					existing.proc?.kill("SIGTERM");
				} catch {}
				runningJobs.delete(key);
				return;
			}

			const gen = ++jobSeq;
			lastBenchErrors.delete(key);
			const child = spawn(
				process.execPath,
				[CALIBRATE_SCRIPT, "--unpin", "--concurrency", "1", `${model.provider}/${model.id}`],
				{
					cwd: path.dirname(CALIBRATE_SCRIPT),
					env: { ...process.env, PI_HASHLINE_CONFIG: resolveConfigPath(agentDir) },
					stdio: ["ignore", "pipe", "pipe"],
					detached: true,
				},
			);
			const job: BenchJobState = { startedAt: Date.now(), gen, proc: child };
			runningJobs.set(key, job);

			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (d) => (stdout += d));
			child.stderr?.on("data", (d) => (stderr += d));
			child.on("close", (code) => {
				const curJob = runningJobs.get(key);
				if (curJob?.gen === gen) {
					runningJobs.delete(key);
				}
				const refreshedCfg = loadConfigSync(agentDir);
				const skipMatch = /\[SKIP\]\s+\S+:\s+(.+)/.exec(stdout);
				if (code !== 0 || skipMatch) {
					lastBenchErrors.set(key, (skipMatch?.[1] || stderr.trim() || `exit ${code}`).slice(0, 120));
				} else {
					lastBenchErrors.delete(key);
				}
				if (!closed) {
					config = refreshedCfg;
					picker.syncState({ config: refreshedCfg });
					tui.requestRender();
				} else {
					const entry = refreshedCfg.calibrated?.[key];
					if (entry) {
						try {
							ctx.ui.notify(
								`hashline bench ${key}: ${entry.use === "hashline" ? "faster → hashline" : "keep replace"}`,
								"info",
							);
						} catch {}
					}
				}
			});
		};

		picker = new HashlinePickerComponent({
			allModels,
			currentModel: ctx.model ?? undefined,
			usage,
			config,
			overrideMode: getOverrideMode(),
			runningJobs,
			lastBenchErrors,
			onToggleModel: toggleModel,
			onUnpinModel: unpinModel,
			onCycleOverrideMode: cycleMode,
			onToggleBenchmark: toggleBenchmark,
			onClose: close,
		});
		picker.focusedState = true;

		void refreshPromise
			.then(() => {
				if (closed) return;
				const refreshed = ctx.modelRegistry.getAvailable();
				if (refreshed.length > 0) {
					picker.syncState({ allModels: refreshed, currentModel: ctx.model ?? undefined });
					tui.requestRender();
				}
			})
			.catch(() => {});

		return {
			get focused() {
				return picker.focused;
			},
			set focused(v: boolean) {
				picker.focusedState = v;
			},
			render(width: number): string[] {
				return picker.render(width, theme);
			},
			invalidate() {
				picker.invalidate();
			},
			handleInput(data: string) {
				picker.handleInput(data);
				tui.requestRender();
			},
		};
	});
}
