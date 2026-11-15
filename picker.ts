/**
 * Interactive TUI menu for `pi-hashline`, modeled directly on `@jangmanj/pi-picks`
 * (big `●` glyph, semantic colors, facet tabs with `<<`/`>>` windowing, live fuzzy search,
 * stable selection identity, a fixed column header row with Ctrl+S sort cycling, and
 * responsive column dropping that never shifts column x-offsets).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Input, Key, type KeyId, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type FrameStyle, type Measure, FRAME_ROWS, KEYS, contentWidth as frameContentWidth, frameLines, spread } from "./frame.ts";
import { type EditChoice, type HashlineConfig, loadConfigSync, resolveModelDecision, saveConfigSync } from "./config.ts";
import { type ReplayRow, type ReplayTable, loadReplayTable, replaySessions, saveReplayTable } from "./replay.ts";

const FREQUENT_TAB = "\0frequent";
const ALL_TAB = "\0all";


export type SortMode =
	| "default"
	| "model-asc"
	| "model-desc"
	| "provider-asc"
	| "provider-desc"
	| "time-asc"
	| "time-desc"
	| "cost-asc"
	| "cost-desc"
	| "edit-asc"
	| "edit-desc";

type Column = "model" | "provider" | "time" | "cost" | "edit";
type RightColumn = "time" | "cost" | "edit";
const RIGHT_ORDER: RightColumn[] = ["time", "cost", "edit"];
/** Narrow-width drop order: Edit stays longest because toggling it is the primary action. */
const DROP_ORDER: RightColumn[] = ["cost", "time", "edit"];
const HEADER_LABEL: Record<Column, string> = {
	model: "Model",
	provider: "Provider",
	time: "Speed",
	cost: "Cost",
	edit: "Edit",
};
const SORT_INFO: Record<Exclude<SortMode, "default">, { column: Column; arrow: "▲" | "▼" }> = {
	"model-asc": { column: "model", arrow: "▲" },
	"model-desc": { column: "model", arrow: "▼" },
	"provider-asc": { column: "provider", arrow: "▲" },
	"provider-desc": { column: "provider", arrow: "▼" },
	"time-asc": { column: "time", arrow: "▲" },
	"time-desc": { column: "time", arrow: "▼" },
	"cost-asc": { column: "cost", arrow: "▲" },
	"cost-desc": { column: "cost", arrow: "▼" },
	"edit-asc": { column: "edit", arrow: "▲" },
	"edit-desc": { column: "edit", arrow: "▼" },
};

/** Speed and Cost cells are signed percentages with one decimal (`+12.3%`). */
const SPEED_MIN_W = Math.max(visibleWidth("Speed ▼"), visibleWidth("+99.9%"));
const COST_MIN_W = Math.max(visibleWidth("Cost ▼"), visibleWidth("+99.9%"));
/** Every possible Edit cell fits this fixed width, so toggling never shifts columns. */
const EDIT_W = Math.max(visibleWidth("● hashline"), visibleWidth("○ built-in"), visibleWidth("Edit ▲"));
/** Speed, Cost and Edit at their usual widths, two columns apart. */
const RIGHT_COLS_W = SPEED_MIN_W + 2 + COST_MIN_W + 2 + EDIT_W;
/** Whether the input is one of the keys the suite's pickers share (`KEYS` in frame.ts). */
const pressed = (data: string, keys: readonly string[]) => keys.some((key) => matchesKey(data, key as KeyId));
const measure: Measure = { width: visibleWidth, truncate: (text, width) => truncateToWidth(text, width) };

/** How many columns the picker's text uses in a terminal this wide: on a wide screen, Speed, Cost and Edit sit on its midline. */
export function contentWidth(termWidth: number): number {
	return frameContentWidth(termWidth, RIGHT_COLS_W);
}
const BOTTOM_KEYS = "  Enter swap · Ctrl+D detail · Ctrl+R reset · Ctrl+S sort · Tab · Esc";
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

export function editToolLabel(use: EditChoice): string {
	return use === "hashline" ? "hashline" : "built-in";
}

/** Signed percentage with one decimal; values that round to zero print as `0.0%`. */
export function fmtPct1(v: number): string {
	const r = Math.round(v * 10) / 10;
	if (r > 0) return `+${r.toFixed(1)}%`;
	if (r < 0) return `-${Math.abs(r).toFixed(1)}%`;
	return "0.0%";
}

const fmtCount = (n: number): string => Math.round(n).toLocaleString("en-US");
const fmtMoney = (n: number): string => (Math.abs(n) >= 100 ? `$${fmtCount(n)}` : `$${n.toFixed(2)}`);

/** Plain-language provenance for a routing decision (uses `built-in` rather than ambiguous `replace`). */
export function describeDecision(dec: { use: EditChoice; source: string }): string {
	const [kind, ...rest] = dec.source.split(":");
	const detail = rest.join(":");
	const tool = editToolLabel(dec.use);
	switch (kind) {
		case "manual":
			return `manual → ${tool}`;
		case "rule": {
			const short = detail.replace(/\*/g, "").replace(/^\/+|\/+$/g, "") || detail;
			return `rule (${short}) → ${tool}`;
		}
		default:
			return `default → ${tool}`;
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
			// Skip sessions run from temp directories (`--tmp--`, `--var-tmp--`) so scratch work does not rank models.
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

export interface PickerCallbacks {
	allModels: Model<Api>[];
	currentModel: Model<Api> | undefined;
	usage: UsageSnapshot;
	config: HashlineConfig;
	/** Per-model figures replayed from the user's own transcripts (no model calls). */
	replay?: ReplayTable;
	/** Set while a replay scan is running, e.g. `replaying 512/2925`. */
	replayStatus?: () => string | undefined;
	onToggleModel: (model: Model<Api>, nextUse: EditChoice) => HashlineConfig;
	onResetModel: (model: Model<Api>) => HashlineConfig;
	/** Open the floating detail pane for a model (Ctrl+D). */
	onShowDetail?: (model: Model<Api>, detail: ModelDetail) => void;
	onClose: () => void;
}

export interface ModelDetail {
	title: string;
	row: ReplayRow | undefined;
}

/**
 * Floating pane with one fact per line for a single model: the two replayed figures and how often each edit
 * tool failed in the user's own sessions. Any key closes it.
 */
export class HashlineDetailPane {
	focused = true;

	constructor(
		private detail: ModelDetail,
		private theme: any,
		private onClose: () => void,
	) {}

	handleInput(_data: string): void {
		this.onClose();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const theme = this.theme;
		const inner = Math.max(10, width - 4);
		const { title, row } = this.detail;
		const pct = (part: number, whole: number) => (whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : "0.0%");
		const tone = (value: number, better: 1 | -1, settled: boolean) => {
			const rounded = (Math.round(value * 10) / 10) * better;
			return !settled ? "dim" : rounded > 0 ? "success" : rounded < 0 ? "error" : "muted";
		};
		/** `label  figure  note`, with the figure in a fixed column so the lines read as a table. */
		const line = (label: string, figure: string, figureColor: string, note: string): Cell => {
			const plain = `${label.padEnd(10)}${figure.padEnd(8)}${note}`;
			return { styled: theme.fg("muted", label.padEnd(10)) + theme.fg(figureColor, theme.bold(figure.padEnd(8))) + theme.fg("text", note), w: visibleWidth(plain) };
		};
		const body: Cell[] = [];
		if (!row) {
			body.push({ styled: theme.fg("muted", "No edits replayed yet."), w: visibleWidth("No edits replayed yet.") });
		} else {
			body.push(
				row.timeSavedPct === null
					? line("Speed", "—", "dim", "no timed edits yet")
					: line("Speed", fmtPct1(row.timeSavedPct), tone(row.timeSavedPct, 1, row.speedSettled), `${(row.secondsPerEdit ?? 0).toFixed(1)} s per edit`),
			);
			body.push(
				row.costSavedPct === null
					? line("Cost", "—", "dim", "no prices recorded")
					: line("Cost", fmtPct1(-row.costSavedPct), tone(-row.costSavedPct, -1, row.costSettled), `of ${fmtMoney(row.spend)} spent`),
			);
			body.push({ styled: "", w: 0 });
			const tried = row.edits.ok + row.edits.failed;
			body.push(line("Built-in", pct(row.edits.failed, tried), "text", `of ${fmtCount(tried)} edits failed`));
			body.push(
				row.hashline.calls > 0
					? line("Hashline", pct(row.hashline.failed, row.hashline.calls), "text", `of ${fmtCount(row.hashline.calls)} calls failed`)
					: line("Hashline", "—", "dim", "never used"),
			);
		}
		const border = (text: string) => theme.fg("border", text);
		const edge = (left: string, text: string, right: string, color: string) => {
			const label = text ? ` ${truncateToWidth(text, Math.max(1, inner - 2), "…")} ` : "";
			return border(`${left}─`) + theme.fg(color, theme.bold(label)) + border("─".repeat(Math.max(0, inner + 1 - visibleWidth(label))) + right);
		};
		const footer = row ? `${fmtCount(row.edits.replayed)} edits replayed` : "";
		const out = [edge("╭", title, "╮", "accent"), border("│") + " ".repeat(inner + 2) + border("│")];
		for (const cell of body) {
			const clipped = cell.w > inner ? { styled: truncateToWidth(cell.styled, inner, "…"), w: inner } : cell;
			out.push(border("│") + " " + padCell(clipped, inner, "left") + " " + border("│"));
		}
		out.push(border("│") + " ".repeat(inner + 2) + border("│"));
		out.push(edge("╰", footer, "╯", "dim"));
		return out;
	}
}

export class HashlinePickerComponent {
	focused = false;

	private categories: string[] = [];
	private byCategory = new Map<string, Model<Api>[]>();
	private allSorted: Model<Api>[] = [];
	private frequentSorted: Model<Api>[] = [];

	private replayRows = new Map<string, ReplayRow>();
	private catIndex = 0;
	private providerLo = 0;
	private rowIndex = 0;
	private selectedKey: string | undefined;
	private sort: SortMode = "default";
	private searchRanked = false;
	private lastWidth: number | undefined;
	private lastTermWidth: number | undefined;

	/**
	 * Left edge of a pane this wide centred over the picker's text, or undefined when the text fills the
	 * terminal and the terminal's own centre is the same place.
	 */
	paneOffsetX(paneWidth: number): number | undefined {
		if (this.lastTermWidth === undefined) return undefined;
		const width = contentWidth(this.lastTermWidth);
		return width < this.lastTermWidth ? Math.max(0, Math.floor((width - paneWidth) / 2)) : undefined;
	}
	private topMatchKey: string | undefined;
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
		// Open on Frequent when the user has session history, favorites or manual choices; otherwise All.
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

	/** Effective sort mode for the active tab, query state, and visible columns. */
	get sortMode(): SortMode {
		return this.effectiveSortMode();
	}

	private get tabs(): string[] {
		return [FREQUENT_TAB, ALL_TAB, ...this.categories];
	}

	private currentTab(): string {
		return this.tabs[this.catIndex] ?? FREQUENT_TAB;
	}

	private get crossProvider(): boolean {
		const tab = this.currentTab();
		return tab === FREQUENT_TAB || tab === ALL_TAB;
	}

	private tabLabel(key: string): string {
		if (key === FREQUENT_TAB) return "Frequent";
		if (key === ALL_TAB) return "All";
		return providerLabel(key);
	}

	private tabSource(key: string): Model<Api>[] {
		if (key === FREQUENT_TAB) return this.frequentSorted;
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

	private isManual(m: Model<Api>): boolean {
		const key = modelKey(m);
		return (this.opts.config.rules ?? []).some((r) => (r.manual ?? (r as any).pinned) === true && r.match.toLowerCase() === key);
	}

	private decisionOf(m: Model<Api>): { use: EditChoice; source: string } {
		return resolveModelDecision(this.opts.config, m);
	}

	syncState(patch: {
		allModels?: Model<Api>[];
		currentModel?: Model<Api>;
		config?: HashlineConfig;
		replay?: ReplayTable;
	}): void {
		const prevTab = this.currentTab();
		if (patch.replay !== undefined) this.opts.replay = patch.replay;
		if (patch.allModels !== undefined) this.opts.allModels = patch.allModels;
		if (patch.currentModel !== undefined) this.opts.currentModel = patch.currentModel;
		if (patch.config !== undefined) this.opts.config = patch.config;
		this.rebuildLists();
		const idx = this.tabs.indexOf(prevTab);
		this.catIndex = idx >= 0 ? idx : 0;
		this.applyFilter();
	}

	private byModelAsc = (a: Model<Api>, b: Model<Api>): number =>
		modelLabel(a).localeCompare(modelLabel(b)) ||
		providerLabel(a.provider).localeCompare(providerLabel(b.provider)) ||
		a.id.localeCompare(b.id);

	private byModelDesc = (a: Model<Api>, b: Model<Api>): number =>
		modelLabel(b).localeCompare(modelLabel(a)) ||
		providerLabel(a.provider).localeCompare(providerLabel(b.provider)) ||
		a.id.localeCompare(b.id);

	private byProvider = (dir: 1 | -1) => (a: Model<Api>, b: Model<Api>): number =>
		dir * providerLabel(a.provider).localeCompare(providerLabel(b.provider)) || this.byModelAsc(a, b);

	private rebuildLists(): void {
		this.replayRows = new Map((this.opts.replay?.rows ?? []).filter((r) => r.edits.replayed > 0).map((r) => [r.model, r]));
		const map = new Map<string, Model<Api>[]>();
		for (const m of this.opts.allModels) {
			if (!map.has(m.provider)) map.set(m.provider, []);
			map.get(m.provider)!.push(m);
		}
		this.byCategory = new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
		this.categories = Array.from(this.byCategory.keys());
		this.allSorted = [...map.values()].flat().sort(this.byModelAsc);
		this.frequentSorted = this.allSorted.filter(
			(m) =>
				this.isCurrent(m) ||
				this.isFavorite(m) ||
				this.usageCount(m) > 0 ||
				this.isManual(m),
		);
	}

	private replayOf(m: Model<Api>): ReplayRow | undefined {
		return this.replayRows.get(modelKey(m));
	}

	/** Share of the model's response time hashline would have saved (positive is better), from the replay. */
	private timeOf(m: Model<Api>): number | undefined {
		const v = this.replayOf(m)?.timeSavedPct;
		return typeof v === "number" && Number.isFinite(v) ? v : undefined;
	}

	/** Change in the model's recorded spend with hashline, as a share of that spend: negative is cheaper, positive costs more. */
	private costOf(m: Model<Api>): number | undefined {
		const v = this.replayOf(m)?.costSavedPct;
		return typeof v === "number" && Number.isFinite(v) ? -v : undefined;
	}

	private putsCurrentFirst(rows: readonly Model<Api>[]): boolean {
		if (!this.opts.currentModel || rows.length <= 1) return false;
		if (!rows.some((m) => this.isCurrent(m))) return false;
		const first = rows.reduce((best, m) => (this.byModelAsc(m, best) < 0 ? m : best), rows[0]!);
		return !this.isCurrent(first);
	}

	private visibleColumns(): Column[] {
		if (this.lastWidth !== undefined && this.lastWidth >= 28) {
			const L = this.layout(this.lastWidth);
			return ["model", ...(L.show ? ["provider" as const] : []), ...L.right];
		}
		return ["model", ...(this.crossProvider ? ["provider" as const] : []), ...RIGHT_ORDER];
	}

	private hasDistinctDefault(): boolean {
		if (this.searchInput.getValue().trim() !== "") return true;
		const tab = this.currentTab();
		if (tab === FREQUENT_TAB) return true;
		if (tab === ALL_TAB) return false;
		return this.putsCurrentFirst(this.tabSource(tab));
	}

	private fallbackSortMode(): Exclude<SortMode, "default"> {
		return "model-asc";
	}

	private effectiveSortMode(): SortMode {
		const hasQuery = this.searchInput.getValue().trim() !== "";
		if (hasQuery && this.searchRanked) return "default";
		const cols = new Set(this.visibleColumns());
		if (this.sort === "default") return this.hasDistinctDefault() ? "default" : this.fallbackSortMode();
		if (!cols.has(SORT_INFO[this.sort].column)) {
			return this.hasDistinctDefault() ? "default" : this.fallbackSortMode();
		}
		return this.sort;
	}

	private activeSortHeader(): { column: Column; arrow: "▲" | "▼" } | undefined {
		const eff = this.effectiveSortMode();
		return eff === "default" ? undefined : SORT_INFO[eff];
	}

	private sortRows(rows: Model<Api>[], mode = this.effectiveSortMode()): Model<Api>[] {
		const byFrequent = (a: Model<Api>, b: Model<Api>) =>
			this.usageCount(b) - this.usageCount(a) ||
			Number(this.isFavorite(b)) - Number(this.isFavorite(a)) ||
			this.byModelAsc(a, b);
		const bySpeed = (dir: 1 | -1) => (a: Model<Api>, b: Model<Api>) => {
			const sa = this.timeOf(a);
			const sb = this.timeOf(b);
			if (sa !== undefined && sb !== undefined) return dir * (sa - sb) || this.byModelAsc(a, b);
			if (sa !== undefined) return -1;
			if (sb !== undefined) return 1;
			return this.byModelAsc(a, b);
		};
		const bySaved = (dir: 1 | -1) => (a: Model<Api>, b: Model<Api>) => {
			const sa = this.costOf(a);
			const sb = this.costOf(b);
			if (sa !== undefined && sb !== undefined) return dir * (sa - sb) || this.byModelAsc(a, b);
			if (sa !== undefined) return -1;
			if (sb !== undefined) return 1;
			return this.byModelAsc(a, b);
		};
		const editRank = (m: Model<Api>) => {
			const d = this.decisionOf(m);
			return (d.use === "hashline" ? 2 : 0) + (d.source.startsWith("manual:") ? 1 : 0);
		};
		let cmp: (a: Model<Api>, b: Model<Api>) => number;
		switch (mode) {
			case "model-asc":
				cmp = this.byModelAsc;
				break;
			case "model-desc":
				cmp = this.byModelDesc;
				break;
			case "provider-asc":
				cmp = this.byProvider(1);
				break;
			case "provider-desc":
				cmp = this.byProvider(-1);
				break;
			case "time-asc":
				cmp = bySpeed(1);
				break;
			case "time-desc":
				cmp = bySpeed(-1);
				break;
			case "cost-asc":
				cmp = bySaved(1);
				break;
			case "cost-desc":
				cmp = bySaved(-1);
				break;
			case "edit-asc":
				cmp = (a, b) => editRank(a) - editRank(b) || this.byModelAsc(a, b);
				break;
			case "edit-desc":
				cmp = (a, b) => editRank(b) - editRank(a) || this.byModelAsc(a, b);
				break;
			default:
				if (this.currentTab() === FREQUENT_TAB) cmp = byFrequent;
				else if (this.crossProvider) cmp = this.byModelAsc;
				else cmp = (a, b) => Number(this.isCurrent(b)) - Number(this.isCurrent(a)) || this.byModelAsc(a, b);
		}
		return [...rows].sort(cmp);
	}

	private applyFilter(): void {
		const query = this.searchInput.getValue().trim();
		const searchText = (m: Model<Api>) =>
			`${m.name} ${m.id} ${m.provider} ${editToolLabel(this.decisionOf(m).use)}`;
		this.globalMatches = fuzzyFilter(this.allSorted, query, searchText);
		const tabRows = this.tabSource(this.currentTab());
		const eff = this.effectiveSortMode();
		if (query) {
			const matched = fuzzyFilter(tabRows, query, searchText);
			this.topMatchKey = matched[0] ? modelKey(matched[0]) : undefined;
			this.filteredRows = eff === "default" ? matched : this.sortRows(matched, eff);
		} else {
			this.topMatchKey = undefined;
			this.filteredRows = this.sortRows(tabRows, eff);
		}
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
		const hasQuery = this.searchInput.getValue().trim() !== "";
		const cols = new Set(this.visibleColumns());
		const colModes = (Object.keys(SORT_INFO) as Exclude<SortMode, "default">[]).filter((m) => cols.has(SORT_INFO[m].column));
		const cycle: SortMode[] = this.hasDistinctDefault() ? ["default", ...colModes] : colModes;
		const cur = this.effectiveSortMode();
		const next = cycle[(cycle.indexOf(cur) + 1) % cycle.length]!;
		this.sort = next;
		this.searchRanked = hasQuery && next === "default";
		const sel = this.filteredRows[this.rowIndex];
		if (sel) this.selectedKey = modelKey(sel);
		this.applyFilter();
	}

	private switchCategory(delta: number): void {
		const tabs = this.tabs;
		const query = this.searchInput.getValue().trim();
		const anyFreq = this.globalMatches.some((m) => this.frequentSorted.some((f) => modelKey(f) === modelKey(m)));
		const visitable = tabs.filter((tab) => {
			if (!query) return true;
			if (tab === ALL_TAB) return true;
			if (tab === FREQUENT_TAB) return anyFreq || this.currentTab() === FREQUENT_TAB;
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

	private resetSelected(): void {
		const sel = this.filteredRows[this.rowIndex];
		if (!sel) return;
		this.selectedKey = modelKey(sel);
		this.opts.config = this.opts.onResetModel(sel);
		this.rebuildLists();
		this.applyFilter();
	}

	/** Ctrl+X: clear the manual choice of every model in the current tab, whatever the search shows of it. */
	private resetTab(): void {
		const sel = this.filteredRows[this.rowIndex];
		if (sel) this.selectedKey = modelKey(sel);
		for (const model of this.tabSource(this.currentTab())) {
			if (this.isManual(model)) this.opts.config = this.opts.onResetModel(model);
		}
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
		if (pressed(data, KEYS.detail)) {
			const sel = this.filteredRows[this.rowIndex];
			if (sel) this.opts.onShowDetail?.(sel, this.detailFor(sel));
			return;
		}
		if (pressed(data, KEYS.sort)) {
			this.cycleSort();
			return;
		}
		if (pressed(data, KEYS.reset)) {
			this.resetSelected();
			return;
		}
		if (pressed(data, KEYS.clearTab)) {
			this.resetTab();
			return;
		}
		// Ctrl+G is Zellij's unlock key: swallow it so it never changes picker state.
		if (matchesKey(data, Key.ctrl("g"))) return;
		if (pressed(data, KEYS.nextTab)) return this.switchCategory(1);
		if (pressed(data, KEYS.prevTab)) return this.switchCategory(-1);
		if (pressed(data, KEYS.pageUp)) return this.moveTo(Math.max(0, this.rowIndex - FRAME_ROWS));
		if (pressed(data, KEYS.pageDown)) return this.moveTo(Math.max(0, Math.min(n - 1, this.rowIndex + FRAME_ROWS)));
		if (matchesKey(data, Key.up)) return this.moveTo(this.rowIndex === 0 ? n - 1 : this.rowIndex - 1);
		if (matchesKey(data, Key.down)) return this.moveTo(this.rowIndex === n - 1 ? 0 : this.rowIndex + 1);
		if (matchesKey(data, Key.left) && this.searchInput.getValue() === "") return this.switchCategory(-1);
		if (matchesKey(data, Key.right) && this.searchInput.getValue() === "") return this.switchCategory(1);

		const before = this.searchInput.getValue();
		this.searchInput.handleInput(data);
		const after = this.searchInput.getValue();
		if (before !== after) {
			this.searchRanked = after.trim() !== "";
			this.rowIndex = 0;
			this.selectedKey = undefined;
			this.applyFilter();
		}
	}

	/** Column widths measured over every row of the active tab plus headers-with-arrow and fixed Edit/Recommended widths. */
	private layout(width: number): Layout {
		const rows = this.tabSource(this.currentTab());
		const show = this.crossProvider;
		const hw = (c: Column) => visibleWidth(`${HEADER_LABEL[c]} ▲`);
		const model = Math.max(
			hw("model"),
			...rows.map((m) => visibleWidth(cleanCellText(modelLabel(m))) + 2),
		);
		const provider = show
			? Math.max(hw("provider"), ...rows.map((m) => visibleWidth(`[${cleanCellText(providerLabel(m.provider))}]`)))
			: 0;
		const w: Record<RightColumn, number> = {
			time: Math.max(SPEED_MIN_W, ...rows.map((m) => visibleWidth(this.fmtTime(m)))),
			cost: Math.max(COST_MIN_W, ...rows.map((m) => visibleWidth(this.fmtCost(m)))),
			edit: EDIT_W,
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
		const active = this.activeSortHeader();
		const cell = (c: Column, maxW: number): Cell => {
			const isActive = c === active?.column;
			if (!isActive) {
				const text = truncateToWidth(HEADER_LABEL[c], Math.max(1, maxW), "");
				return { styled: theme.fg("accent", text), w: visibleWidth(text) };
			}
			const arrow = maxW >= 3 ? ` ${active!.arrow}` : "";
			const label = truncateToWidth(HEADER_LABEL[c], Math.max(1, maxW - visibleWidth(arrow)), "");
			const styled =
				theme.bold(theme.fg("accent", label)) + (arrow ? theme.bold(theme.fg("warning", arrow)) : "");
			return { styled, w: visibleWidth(label) + visibleWidth(arrow) };
		};
		return this.compose(L, { styled: "  ", w: 2 }, {
			model: cell("model", L.modelW),
			provider: cell("provider", L.provW),
			time: cell("time", L.w.time),
			cost: cell("cost", L.w.cost),
			edit: cell("edit", L.w.edit),
		});
	}

	render(termWidth: number, theme: any): string[] {
		const width = contentWidth(termWidth);
		this.lastTermWidth = termWidth;
		if (width < 28) {
			return [
				theme.fg("warning", truncateToWidth("Terminal too narrow for /hashline", Math.max(1, width))),
				theme.fg("dim", truncateToWidth("Esc: close", Math.max(1, width))),
			];
		}
		if (this.lastWidth !== width) {
			this.lastWidth = width;
			this.applyFilter();
		}

		const replayCount = this.replayRows.size;
		const scanning = this.opts.replayStatus?.();
		const badgeText = [replayCount > 0 ? `${replayCount} replayed` : "", scanning ?? ""].filter(Boolean).join(" · ");
		const badge = badgeText ? theme.fg(scanning ? "warning" : "muted", badgeText) : undefined;
		const tabs = this.renderTabs(width, theme);

		// Search input
		const promptText = "  Search: ";
		const promptW = visibleWidth(promptText);
		const inputLines = this.searchInput.render(Math.max(0, width - promptW));
		const input = theme.fg("muted", promptText) + (inputLines[0] ?? "");

		const L = this.layout(width);
		const header = this.renderHeader(L, theme);

		// Model rows
		const MAX_VISIBLE = FRAME_ROWS;
		const lines: string[] = [];
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
			} else {
				msg = "  No models in this tab";
			}
			lines.push(theme.fg("muted", truncateToWidth(msg, width)));
		} else {
			for (let i = 0; i < visible.length; i++) {
				const model = visible[i]!;
				const absIdx = start + i;
				const fuzzyHighlight = hasQuery ? (this.topMatchKey === modelKey(model) ? "top" : "match") : undefined;
				lines.push(this.renderRow(model, absIdx === this.rowIndex, this.isCurrent(model), L, theme, fuzzyHighlight));
			}
		}

		// One line about the selected model.
		const position = rows.length ? this.rowIndex + 1 : 0;
		const selected = rows[this.rowIndex];
		let detailLine = `  (${position}/${rows.length})`;
		const notes: string[] = [];
		if (selected) {
			detailLine += ` ${cleanCellText(`${selected.provider}/${selected.id}`)}`;
			// One plain sentence whenever a figure for this model is not settled yet, whatever the reason.
			const replayRow = this.replayOf(selected);
			if (!(replayRow?.speedSettled && replayRow.costSettled)) {
				notes.push(`${fmtCount(replayRow?.edits.replayed ?? 0)} edits replayed so far; figures settle as you work`);
			}
			notes.push(describeDecision(this.decisionOf(selected)));
		}
		// The notes belong on the key bar, right-aligned. Whatever does not fit beside the keys stays on this line.
		const barNotes = [notes, notes.slice(0, 1), notes.slice(-1)].find((n) => n.length > 0 && this.fitsBottomBar(n, width)) ?? [];
		for (const note of notes) if (!barNotes.includes(note)) detailLine += ` · ${note}`;
		// Sorted by Speed or Cost, the Edit column is judged on that measure, and the legend says so.
		const basis = this.editBasis();
		const legendGood = basis === "speed" ? "faster tool" : "cheaper tool";
		const legendOther = basis === "speed" ? "slower tool" : "costlier tool";
		const legend = basis
			? theme.fg("success", "●") + theme.fg("dim", ` ${legendGood}  `) + theme.fg("error", "●") + theme.fg("dim", ` ${legendOther}`)
			: "";
		const status =
			(legend && spread(theme.fg("dim", detailLine), legend, width, measure)) || theme.fg("dim", truncateToWidth(detailLine, width));

		const style: FrameStyle = {
			accent: (text) => theme.fg("accent", text),
			bold: (text) => theme.bold(text),
			border: (text) => theme.fg("border", text),
		};
		const keys = this.renderBottomBar(width, theme, barNotes);
		return frameLines({ title: "Hashline Edit Routing", badge, tabs, input, header, rows: lines, status, keys }, width, termWidth, style, measure);
	}

	/** Whether these notes fit on the key bar with two columns between them and the keys and two before the right edge. */
	private fitsBottomBar(notes: string[], width: number): boolean {
		return spread(BOTTOM_KEYS, notes.join(" · "), width, measure) !== undefined;
	}

	/** Key hints on the left; the selected model's notes on the right when they fit. */
	private renderBottomBar(width: number, theme: any, notes: string[]): string {
		const line = notes.length ? spread(BOTTOM_KEYS, notes.join(" · "), width, measure) : undefined;
		return theme.fg("dim", line ?? truncateToWidth(BOTTOM_KEYS, width, "…"));
	}

	/** Replayed time saving as a signed percentage, or empty when the model has no replayable edits. */
	private fmtTime(m: Model<Api>): string {
		const v = this.timeOf(m);
		return v !== undefined ? fmtPct1(v) : "";
	}

	private fmtCost(m: Model<Api>): string {
		const v = this.costOf(m);
		return v !== undefined ? fmtPct1(v) : "";
	}

	/**
	 * Green when hashline is better, red when worse, neutral at zero; dim while the user's sessions have not settled its sign.
	 * `better` is the sign that counts as good: +1 for Speed (faster), -1 for Cost (cheaper).
	 */
	private signedCell(text: string, value: number | undefined, better: 1 | -1, unsettled: boolean, theme: any, bold: (s: string) => string): Cell {
		if (!text || value === undefined) return { styled: "", w: 0 };
		const rounded = (Math.round(value * 10) / 10) * better;
		const color = unsettled ? "dim" : rounded > 0 ? "success" : rounded < 0 ? "error" : "muted";
		return { styled: theme.fg(color, unsettled ? text : bold(text)), w: visibleWidth(text) };
	}

	private timeCell(m: Model<Api>, theme: any, bold: (s: string) => string): Cell {
		return this.signedCell(this.fmtTime(m), this.timeOf(m), 1, this.replayOf(m)?.speedSettled !== true, theme, bold);
	}

	private costCell(m: Model<Api>, theme: any, bold: (s: string) => string): Cell {
		return this.signedCell(this.fmtCost(m), this.costOf(m), -1, this.replayOf(m)?.costSettled !== true, theme, bold);
	}

	/** The measure the list is sorted by, when that measure can judge an edit tool. */
	private editBasis(): "speed" | "cost" | undefined {
		const mode = this.effectiveSortMode();
		return mode.startsWith("time-") ? "speed" : mode.startsWith("cost-") ? "cost" : undefined;
	}

	/** Which tool does better for this model on one measure alone; undefined when there is no clear figure. */
	private betterTool(m: Model<Api>, basis: "speed" | "cost"): EditChoice | undefined {
		const row = this.replayOf(m);
		if (!row || !(basis === "speed" ? row.speedSettled : row.costSettled)) return undefined;
		const v = basis === "speed" ? this.timeOf(m) : this.costOf(m);
		if (v === undefined) return undefined;
		const rounded = Math.round(v * 10) / 10;
		if (rounded === 0) return undefined;
		return (basis === "speed" ? rounded > 0 : rounded < 0) ? "hashline" : "replace";
	}

	/**
	 * The model's current edit tool. Sorted by Speed or Cost, it is green when that tool is the better one
	 * on that measure and red when it is not; the two measures are never combined into one verdict.
	 */
	private editCell(m: Model<Api>, theme: any, bold: (s: string) => string): Cell {
		const dec = this.decisionOf(m);
		const body = dec.use === "hashline" ? "● hashline" : "○ built-in";
		const basis = this.editBasis();
		let color = dec.use === "hashline" ? "success" : "muted";
		if (basis) {
			const better = this.betterTool(m, basis);
			color = better === undefined ? "muted" : better === dec.use ? "success" : "error";
		}
		return { styled: theme.fg(color, bold(body)), w: visibleWidth(body) };
	}

	/** What the floating detail pane shows for one model. */
	private detailFor(model: Model<Api>): ModelDetail {
		return { title: cleanCellText(modelLabel(model)), row: this.replayOf(model) };
	}

	private renderTabs(width: number, theme: any): string {
		const activeKey = this.currentTab();
		const hasQuery = this.searchInput.getValue().trim() !== "";
		const freqKeys = new Set(this.frequentSorted.map(modelKey));
		const anyFreqMatch = this.globalMatches.some((m) => freqKeys.has(modelKey(m)));

		const SEP = theme.fg("dim", "│");
		const SEP_W = 1;
		const labelOf = (key: string) => ` ${this.tabLabel(key)} `;
		const segment = (key: string): string => {
			const label = labelOf(key);
			const selected = key === activeKey;
			const matches =
				key === FREQUENT_TAB
					? anyFreqMatch
					: key === ALL_TAB
						? this.globalMatches.length > 0
						: this.matchingProviders.has(key);
			const color = selected ? "accent" : hasQuery ? (matches ? "success" : "dim") : "muted";
			const styled = theme.fg(color, selected ? theme.bold(label) : label);
			if (selected) return theme.bg("selectedBg", styled);
			return hasQuery && matches ? theme.bg("customMessageBg", styled) : styled;
		};

		const fixedTabs = [FREQUENT_TAB, ALL_TAB];
		const fixedPart = fixedTabs.map(segment).join(SEP);
		const fixedW = fixedTabs.reduce((sum, key) => sum + visibleWidth(labelOf(key)), 0) + (fixedTabs.length - 1) * SEP_W;
		const providers = this.categories;
		if (!providers.length || width - 2 - fixedW < 14) {
			return truncateToWidth("  " + fixedPart, width);
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
			const avail = Math.max(0, width - 2 - fixedW - SEP_W - reserve);
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
		return truncateToWidth("  " + fixedPart + SEP + leftPart + providerPart + rightPart, width);
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
		// One status dot, used as sparingly as in pi-picks: gold for a favorite, green for the active model, none otherwise.
		// The edit tool is shown by the Edit column alone.
		const dotColor = this.isFavorite(model) ? "warning" : isCurrent ? "success" : undefined;
		const rowColor = isSelected ? "accent" : isCurrent ? "success" : "text";
		const sideColor = isSelected ? "accent" : isCurrent ? "success" : "muted";

		const name = truncateToWidth(cleanCellText(modelLabel(model)), Math.max(1, L.modelW - 2), "…");
		const modelCell: Cell = {
			styled: theme.fg(rowColor, name) + (dotColor ? theme.fg(dotColor, theme.bold(" ●")) : ""),
			w: visibleWidth(name) + (dotColor ? 2 : 0),
		};
		const provText = L.show ? truncateToWidth(`[${cleanCellText(providerLabel(model.provider))}]`, L.provW, "…") : "";

		const line = this.compose(L, { styled: theme.fg(rowColor, isSelected ? "▶ " : "  "), w: 2 }, {
			model: modelCell,
			provider: { styled: theme.fg(sideColor, provText), w: visibleWidth(provText) },
			time: this.timeCell(model, theme, bold),
			cost: this.costCell(model, theme, bold),
			edit: this.editCell(model, theme, bold),
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
}

const DETAIL_PANE_WIDTH = 52;
/** Rows between the bottom of the terminal and the last list row: Pi's footer (about 2), then the frame's rule, key bar, rule and status line. */
const DETAIL_PANE_LIFT = 6;
const detailPaneOptions = (offsetX: number | undefined) =>
	offsetX === undefined
		? { anchor: "bottom-center" as const, width: DETAIL_PANE_WIDTH, offsetY: -DETAIL_PANE_LIFT }
		: { anchor: "bottom-left" as const, width: DETAIL_PANE_WIDTH, offsetX, offsetY: -DETAIL_PANE_LIFT };
/** One transcript replay at a time per agent directory, shared by every open menu. */
const replayScans = new Map<string, Promise<ReplayTable>>();

export async function openHashlineMenu(opts: OpenHashlineMenuOptions): Promise<void> {
	const { ctx } = opts;
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
	let config = loadConfigSync(agentDir, true, true);
	// Show the last replay at once, then rescan the transcripts in the background (unchanged sessions are cached).
	const savedReplay = loadReplayTable(agentDir);
	let replayProgress: string | undefined;

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		let closed = false;
		let picker: HashlinePickerComponent;

		const tick = setInterval(() => {
			if (!closed && replayProgress) {
				tui.requestRender();
			}
		}, 500);
		tick.unref?.();

		const close = () => {
			if (closed) return;
			closed = true;
			clearInterval(tick);
			done();
		};

		const isManualMatch = (r: any, key: string) =>
			(r?.manual ?? r?.pinned) === true && String(r?.match ?? "").toLowerCase() === key;

		const toggleModel = (model: Model<Api>, nextUse: EditChoice): HashlineConfig => {
			const key = modelKey(model);
			const fresh = loadConfigSync(agentDir, true, true);
			fresh.rules = (fresh.rules ?? []).filter((r) => !isManualMatch(r, key));
			fresh.rules.unshift({ match: key, use: nextUse, manual: true, note: "set in /hashline menu" });
			saveConfigSync(fresh, agentDir);
			config = fresh;
			return fresh;
		};

		const resetModel = (model: Model<Api>): HashlineConfig => {
			const key = modelKey(model);
			const fresh = loadConfigSync(agentDir, true, true);
			fresh.rules = (fresh.rules ?? []).filter((r) => !isManualMatch(r, key));
			saveConfigSync(fresh, agentDir);
			config = fresh;
			return fresh;
		};

		picker = new HashlinePickerComponent({
			allModels,
			currentModel: ctx.model ?? undefined,
			usage,
			config,
			replay: savedReplay,
			replayStatus: () => replayProgress,
			onToggleModel: toggleModel,
			onResetModel: resetModel,
			onShowDetail: (_model, detail) => {
				// A floating pane over the picker; any key closes it and returns input to the list.
				void ctx.ui
					.custom<void>((_tui, paneTheme, _kb, closePane) => new HashlineDetailPane(detail, paneTheme, () => closePane()), {
						overlay: true,
						// Sit over the list rows: above the picker's status line and key bar, and whatever footer Pi draws below them.
						// On a wide screen the picker's text stops short of the right edge, and the pane is centred over the text.
						overlayOptions: detailPaneOptions(picker.paneOffsetX(DETAIL_PANE_WIDTH)),
					})
					.then(() => {
						if (!closed) tui.requestRender();
					})
					.catch(() => {});
			},
			onClose: close,
		});
		picker.focusedState = true;

		let scan = replayScans.get(agentDir);
		if (!scan) {
			scan = replaySessions({
				sessionsDir: path.join(agentDir, "sessions"),
				onProgress: (done, total) => {
					replayProgress = done < total ? `replaying ${done}/${total}` : undefined;
				},
			}).finally(() => replayScans.delete(agentDir));
			replayScans.set(agentDir, scan);
		}
		void scan
			.then((table) => {
				replayProgress = undefined;
				try {
					saveReplayTable(table, agentDir);
				} catch {}
				if (closed) return;
				picker.syncState({ replay: table });
				tui.requestRender();
			})
			.catch(() => {
				replayProgress = undefined;
			});

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
