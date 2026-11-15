#!/usr/bin/env node
/**
 * Build a replay seed: per-model sums from Pi session directories that live somewhere other than this
 * machine's `~/.pi/agent/sessions` (another machine, an archive, a restored home directory).
 *
 * Copy the output to `~/.pi/agent/hashline-replay-seed.json` on the machine whose picker should include it.
 * A session file name is counted once: across the sources given here, and against `--skip-names`
 * (a text file of session file names already present where the seed will be installed).
 *
 * Usage: node scripts/build-replay-seed.ts --out seed.json [--skip-names names.txt] [--host NAME] label=dir [label=dir ...]
 */
import * as fs from "node:fs";
import * as os from "node:os";
import { REPLAY_VERSION, type ReplaySeed, collectPartials } from "../replay.ts";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
};
const out = flag("--out");
const skipFile = flag("--skip-names");
const host = flag("--host") ?? os.hostname();
const sources = argv.filter((a, i) => a.includes("=") && !a.startsWith("--") && !["--out", "--skip-names", "--host"].includes(argv[i - 1] ?? ""));
if (!out || sources.length === 0) {
	console.error("usage: build-replay-seed.ts --out seed.json [--skip-names names.txt] [--host NAME] label=dir [label=dir ...]");
	process.exit(2);
}

const seen = new Set<string>(skipFile ? fs.readFileSync(skipFile, "utf8").split("\n").filter(Boolean) : []);
const skippedBefore = seen.size;
const seed: ReplaySeed = { version: REPLAY_VERSION, generatedAt: new Date().toISOString(), sources: [] };
for (const spec of sources) {
	const at = spec.indexOf("=");
	const label = spec.slice(0, at);
	const dir = spec.slice(at + 1).replace(/^~/, os.homedir());
	const before = seen.size;
	const { files, units } = await collectPartials(dir, seen);
	seed.sources.push({ label, host, files, units });
	const partials = units.flatMap((u) => Object.values(u));
	const edits = partials.reduce((n, p) => n + p.editsOk, 0);
	const responses = partials.reduce((n, p) => n + p.responses, 0);
	const models = new Set(units.flatMap((u) => Object.keys(u))).size;
	console.log(`${label}: ${files} session files (${seen.size - before} new names), ${units.length} units, ${models} models, ${responses} responses, ${edits} successful edits`);
}
fs.writeFileSync(out, JSON.stringify(seed) + "\n");
console.log(`wrote ${out} (names known beforehand: ${skippedBefore})`);
