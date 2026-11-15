const HUNK_LINES = 6;
const OCCURRENCE_LIMIT = 8;

function numbered(lines: string[], start: number, end: number): string {
	return lines.slice(start, end).map((line, i) => {
		const short = line.length > 180 ? `${line.slice(0, 179)}…` : line;
		return `${start + i + 1}: ${short}`;
	}).join("\n");
}

/** Rank oldText-sized windows by multiset line overlap, ignoring blank lines
 * and leading/trailing whitespace. Hints only: these are not safe edit targets. */
export function notFoundMessage(fileText: string, oldText: string): string {
	const lines = fileText.split(/\r?\n/);
	const wanted = oldText.split(/\r?\n/);
	const counts = new Map<string, number>();
	for (const line of wanted) {
		const key = line.trim();
		if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const width = Math.min(wanted.length, lines.length);
	const keys = lines.map(line => line.trim());
	const windowCounts = new Map<string, number>();
	let score = 0;
	function change(key: string, delta: number): void {
		const before = windowCounts.get(key) ?? 0;
		const limit = counts.get(key) ?? 0;
		score += Math.min(before + delta, limit) - Math.min(before, limit);
		windowCounts.set(key, before + delta);
	}
	for (let i = 0; i < width; i++) change(keys[i], 1);
	const candidates: { start: number; score: number }[] = [];
	for (let start = 0; start <= lines.length - width; start++) {
		if (score > 0) candidates.push({ start, score });
		if (start + width < lines.length) {
			change(keys[start], -1);
			change(keys[start + width], 1);
		}
	}
	candidates.sort((a, b) => b.score - a.score || a.start - b.start);
	const selected: number[] = [];
	for (const candidate of candidates) {
		if (selected.every(start => Math.abs(start - candidate.start) >= width)) {
			selected.push(candidate.start);
			if (selected.length === 2) break;
		}
	}
	if (!selected.length) return "Text not found; no overlapping nonblank lines.";
	return "Text not found. Closest hunks (verify before retrying):\n" + selected.map(start => {
		const end = start + width;
		const first = keys.findIndex((key, i) => i >= start && i < end && counts.has(key));
		const shown = Math.max(start, first - 1);
		const stop = Math.min(end, shown + HUNK_LINES);
		return `Lines ${start + 1}–${end}:\n${shown > start ? "…\n" : ""}${numbered(lines, shown, stop)}${stop < end ? "\n…" : ""}`;
	}).join("\n");
}

/** List exact substring occurrences, including overlaps; show one preceding line
 * and the first matching line per occurrence. Empty oldText has no useful target. */
export function notUniqueMessage(fileText: string, oldText: string): string {
	if (!oldText) return "Empty oldText; supply nonempty text to locate occurrences.";
	const lines = fileText.split(/\r?\n/);
	const shown: string[] = [];
	let total = 0;
	let scanned = 0;
	let line = 0;
	for (let offset = fileText.indexOf(oldText); offset !== -1; offset = fileText.indexOf(oldText, offset + 1)) {
		while (scanned < offset) {
			if (fileText[scanned] === "\n") line++;
			scanned++;
		}
		total++;
		if (shown.length < OCCURRENCE_LIMIT) {
			shown.push(`Occurrence ${total} at line ${line + 1}:\n${numbered(lines, Math.max(0, line - 1), line + 1)}`);
		}
	}
	return `${total} exact occurrences${total > OCCURRENCE_LIMIT ? ` (showing first ${OCCURRENCE_LIMIT})` : ""}.` +
		(shown.length ? `\n${shown.join("\n")}` : "");
}
