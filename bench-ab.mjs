#!/usr/bin/env node
/**
 * Head-to-head paired A/B benchmark: Stock Pi `edit(oldText, newText)` vs `pi-hashline` (`oh-my-pi` hashline engine)
 * on a ~620-line SQL + TypeScript analytics repository refactor with 5 non-adjacent hunks and a real verification suite.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MODEL = process.argv[2] || "antigravity/gemini-4-carbon";
const THINKING = process.argv[3] || "high";
const EXT_PATH = path.resolve(import.meta.dirname, "index.ts");

function generateRepoSource() {
	const lines = [
		"/** Analytics query repository (620-line realistic multi-query module). */",
		"export interface QueryParams {",
		"  tenantId: string;",
		"  sinceIso: string;",
		"  untilIso: string;",
		"  limit?: number;",
		"}",
		"",
		"export interface SqlSpec {",
		"  name: string;",
		"  sql: string;",
		"  params: unknown[];",
		"}",
		"",
	];

	const reports = [
		["activeSubscriptions", "subscriptions", "status = 'active'"],
		["monthlyRevenue", "invoices", "paid = true"],
		["trialConversions", "trials", "converted = true"],
		["churnedAccounts", "subscriptions", "status = 'canceled'"],
		["seatUtilization", "workspace_seats", "assigned = true"],
		["apiUsageRollup", "api_events", "http_status < 500"],
		["webhookDeliveries", "webhook_attempts", "delivered = true"],
		["supportEscalations", "tickets", "priority = 'urgent'"],
		["invoiceAging", "invoices", "paid = false"],
		["auditTrailExport", "audit_events", "actor_type = 'user'"],
		["storageSnapshots", "bucket_metrics", "bytes_used > 0"],
		["tokenConsumption", "llm_ ledger".replace(" ", "_"), "billable = true"],
	];

	for (let i = 0; i < reports.length; i++) {
		const [fnName, table, pred] = reports[i];
		lines.push(`/** Build the ${fnName} report query for a single tenant window. */`);
		lines.push(`export function build_${fnName}(p: QueryParams): SqlSpec {`);
		lines.push(`  const cap = p.limit ?? ${50 + i * 25};`);
		lines.push(`  const sql = \``);
		lines.push(`    SELECT`);
		lines.push(`      t.id,`);
		lines.push(`      t.tenant_id,`);
		lines.push(`      t.created_at,`);
		lines.push(`      t.updated_at,`);
		lines.push(`      COUNT(*) OVER () AS total_rows`);
		lines.push(`    FROM public.${table} AS t`);
		lines.push(`    INNER JOIN public.tenants AS ten`);
		lines.push(`      ON ten.id = t.tenant_id`);
		lines.push(`    WHERE t.tenant_id = $1`);
		lines.push(`      AND ${pred}`);
		lines.push(`      AND t.created_at >= $2`);
		lines.push(`      AND t.created_at < $3`);
		lines.push(`    ORDER BY t.created_at DESC, t.id ASC`);
		lines.push(`    LIMIT $4`);
		lines.push(`  \`.trim();`);
		lines.push(`  return {`);
		lines.push(`    name: "${fnName}",`);
		lines.push(`    sql,`);
		lines.push(`    params: [p.tenantId, p.sinceIso, p.untilIso, cap],`);
		lines.push(`  };`);
		lines.push(`}`);
		lines.push(``);
		// Add realistic helper formatter per report (~18 lines each -> ~600+ lines total)
		lines.push(`export function summarize_${fnName}Sql(p: QueryParams): string {`);
		lines.push(`  const spec = build_${fnName}(p);`);
		lines.push(`  const normalized = spec.sql`);
		lines.push(`    .split("\\n")`);
		lines.push(`    .map((ln) => ln.trim())`);
		lines.push(`    .filter(Boolean)`);
		lines.push(`    .join(" ");`);
		lines.push(`  return \`[\${spec.name}] params=\${spec.params.length} sql=\${normalized}\`;`);
		lines.push(`}`);
		lines.push(``);
	}
	return lines.join("\n") + "\n";
}

const PROMPT = `Refactor \`analytics-repo.ts\` (do NOT rewrite the whole file with \`write\`; use targeted edits on \`analytics-repo.ts\` and keep all other functions untouched):
1. Add optional \`includeSoftDeleted?: boolean\` to \`QueryParams\`.
2. In ONLY these five query builders — \`build_activeSubscriptions\`, \`build_trialConversions\`, \`build_apiUsageRollup\`, \`build_invoiceAging\`, and \`build_tokenConsumption\` — exclude soft-deleted rows by adding \`AND ($5::boolean OR t.deleted_at IS NULL)\` AND \`AND ten.suspended_at IS NULL\` to the \`WHERE\` clause, and append \`Boolean(p.includeSoftDeleted)\` as the 5th element of \`params\`. Leave the other 7 query builders unchanged at 4 params!
3. Run \`node verify.mjs\` via \`bash\` to confirm all assertions pass, then reply in one short line.`;

const VERIFY_MJS = `import assert from "node:assert/strict";
import * as mod from "./analytics-repo.ts";

const target5 = ["activeSubscriptions", "trialConversions", "apiUsageRollup", "invoiceAging", "tokenConsumption"];
const untouched7 = ["monthlyRevenue", "churnedAccounts", "seatUtilization", "webhookDeliveries", "supportEscalations", "auditTrailExport", "storageSnapshots"];

for (const name of target5) {
  const s1 = mod["build_" + name]({ tenantId: "t1", sinceIso: "2026-01-01", untilIso: "2026-02-01" });
  assert.equal(s1.params.length, 5, name + " should have 5 params");
  assert.equal(s1.params[4], false, name + " default includeSoftDeleted should be false");
  assert.ok(s1.sql.includes("t.deleted_at IS NULL"), name + " missing deleted_at filter");
  assert.ok(s1.sql.includes("ten.suspended_at IS NULL"), name + " missing suspended_at filter");

  const s2 = mod["build_" + name]({ tenantId: "t1", sinceIso: "2026-01-01", untilIso: "2026-02-01", includeSoftDeleted: true });
  assert.equal(s2.params[4], true, name + " includeSoftDeleted=true");
}

for (const name of untouched7) {
  const s = mod["build_" + name]({ tenantId: "t1", sinceIso: "2026-01-01", untilIso: "2026-02-01" });
  assert.equal(s.params.length, 4, name + " must stay at 4 params");
  assert.ok(!s.sql.includes("deleted_at"), name + " must not have deleted_at");
}
console.log("VERIFY_OK");
`;

function runArm(name, extraArgs) {
	return new Promise((resolve) => {
		const root = fs.mkdtempSync(path.join("/var/tmp", `hl-ab-${name}-`));
		const agentDir = path.join(root, "piagent");
		const ws = path.join(root, "ws");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(ws, { recursive: true });
		fs.symlinkSync(path.join(os.homedir(), ".pi/agent/auth.json"), path.join(agentDir, "auth.json"));
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always", quietStartup: "header" }));
		const src = generateRepoSource();
		fs.writeFileSync(path.join(ws, "analytics-repo.ts"), src, "utf8");
		fs.writeFileSync(path.join(ws, "verify.mjs"), VERIFY_MJS, "utf8");

		const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, TMPDIR: root };
		for (const k of Object.keys(env)) {
			if (k.startsWith("JING_") || k.startsWith("ZELLIJ")) delete env[k];
		}

		const args = ["--no-extensions", ...extraArgs, "--model", MODEL, "--thinking", THINKING, "--mode", "json", "-p", PROMPT];
		const t0 = performance.now();
		const child = spawn("pi", args, { cwd: ws, env, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("close", (code) => {
			const wallSec = Math.round(((performance.now() - t0) / 1000) * 100) / 100;
			let editCalls = 0;
			let editErrors = 0;
			let editArgBytes = 0;
			let outTokens = 0;
			let turns = 0;
			for (const line of out.split("\n")) {
				if (!line.startsWith("{")) continue;
				try {
					const ev = JSON.parse(line);
					if (ev.type === "message_end" && ev.message?.role === "assistant") {
						turns++;
						outTokens += ev.message?.usage?.output ?? 0;
						for (const b of ev.message?.content ?? []) {
							if (b.type === "toolCall" && (b.name === "edit" || b.name === "hashline_edit")) {
								editCalls++;
								editArgBytes += Buffer.byteLength(JSON.stringify(b.arguments ?? {}), "utf8");
							}
						}
					}
					if (ev.type === "message_end" && ev.message?.role === "toolResult") {
						if ((ev.message.toolName === "edit" || ev.message.toolName === "hashline_edit") && ev.message.isError) {
							editErrors++;
						}
					}
				} catch {}
			}

			// Independent verification
			const ver = spawn("node", ["verify.mjs"], { cwd: ws });
			let verOut = "";
			ver.stdout.on("data", (d) => (verOut += d));
			ver.stderr.on("data", (d) => (verOut += d));
			ver.on("close", (vCode) => {
				fs.writeFileSync(path.join(root, "trace.jsonl"), out, "utf8");
				resolve({
					arm: name,
					model: MODEL,
					thinking: THINKING,
					fileLines: src.split("\n").length,
					pass: vCode === 0 && verOut.includes("VERIFY_OK"),
					wallSec,
					turns,
					editCalls,
					editErrors,
					editArgBytes,
					outTokens,
					exitCode: code,
					dir: root,
					errTail: err.slice(-300),
				});
			});
		});
	});
}

const [stock, hashline] = await Promise.all([
	runArm("stock-edit", []),
	runArm("pi-hashline", ["-e", EXT_PATH]),
]);

console.log(JSON.stringify({ stock, hashline, speedup: +(stock.wallSec / hashline.wallSec).toFixed(2), argBytesRatio: +(stock.editArgBytes / Math.max(1, hashline.editArgBytes)).toFixed(2) }, null, 2));
