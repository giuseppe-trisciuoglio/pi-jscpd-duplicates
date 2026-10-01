/**
 * Asynchronous copy-paste detection for the coding agent.
 *
 * Whenever the agent finishes writing a source file, a jscpd scan of the
 * project is scheduled in the background (debounced, so bursts of writes
 * produce one scan). The scan overlaps the rest of the agent's turn, so the
 * result is normally ready by the time the turn ends. At the final
 * pre-settle boundary the extension checks the result: if the freshly
 * written code duplicated something, it injects one message into the
 * conversation and requests a single continuation so the agent can refactor
 * immediately. The user always gets a notification regardless.
 */
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	collectFormats,
	extensionToFormat,
	filterInvolving,
	formatMessage,
	runScan,
	signature,
	type ScanResult,
} from "./scan.ts";

// Tunables. Kept as constants for simplicity; move to settings if needed.
const MIN_TOKENS = 50;
const DEBOUNCE_MS = 3_000;
const SCAN_TIMEOUT_MS = 90_000;
const MAX_REFACTOR_ROUNDS = 2;

type NotifyCtx = { ui?: { notify: (m: string, t?: "info" | "warning" | "error") => void } };

export default function jscpdDuplicates(pi: ExtensionAPI) {
	// Guard against double registration if the module is loaded twice in one
	// process (explicit flag plus auto-discovery, or a reload race).
	const g = globalThis as Record<string, unknown>;
	const sentinel = "__jscpdDuplicatesLoaded";
	if (g[sentinel]) return;
	g[sentinel] = true;

	const written = new Set<string>();
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let scanPromise: Promise<ScanResult | null> | null = null;
	let roundsUsed = 0;
	let lastSignature = "";

	function notify(ctx: NotifyCtx, msg: string, level: "info" | "warning" | "error") {
		ctx.ui?.notify(msg, level);
	}

	/** Starts (or joins) a background scan of the project root. */
	function fireScan(cwd: string): Promise<ScanResult | null> {
		if (scanPromise) return scanPromise;
		if (written.size === 0) return Promise.resolve(null);
		const formats = collectFormats([...written]);
		if (formats.length === 0) return Promise.resolve(null);
		scanPromise = runScan(pi.exec, {
			cwd,
			formats,
			minTokens: MIN_TOKENS,
			timeoutMs: SCAN_TIMEOUT_MS,
		}).catch(() => null satisfies ScanResult | null);
		return scanPromise;
	}

	function scheduleScan(cwd: string) {
		if (debounceTimer) clearTimeout(debounceTimer);
		// Any earlier result is now stale: files changed after it completed.
		scanPromise = null;
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			void fireScan(cwd);
		}, DEBOUNCE_MS);
	}

	pi.on("tool_result", (event, ctx) => {
		if (event.isError) return;
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const input = event.input as Record<string, unknown>;
		const raw = input.path ?? input.file_path ?? input.filePath;
		if (typeof raw !== "string") return;
		if (!extensionToFormat(path.extname(raw).slice(1))) return;
		const abs = path.resolve(ctx.cwd, raw);
		// jscpd scans the project root only; skip files outside it.
		if (!abs.startsWith(ctx.cwd + path.sep)) return;
		written.add(abs);
		scheduleScan(ctx.cwd);
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (written.size === 0) return;
		const writtenNow = new Set(written);
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
		const result = await fireScan(ctx.cwd);
		// Consume per-turn state no matter the outcome so nothing leaks into
		// the next turn.
		written.clear();
		scanPromise = null;
		if (result === null) {
			notify(ctx, "jscpd: background scan failed or timed out; skipping this turn", "error");
			return;
		}
		const relevant = filterInvolving(result.clones, writtenNow, result.root);
		if (relevant.length === 0) {
			lastSignature = "";
			return;
		}
		const report: ScanResult = { ...result, clones: relevant };
		const sig = signature(report);
		const alreadyReported = sig === lastSignature;
		lastSignature = sig;
		notify(ctx, `jscpd: ${relevant.length} duplicated block(s) in freshly written code`, "warning");
		// Only ask the agent to fix things when it can actually act: not on
		// aborted runs, not when the last refactor changed nothing, and only
		// a bounded number of times per conversation chain.
		if (event.outcome !== "completed" || alreadyReported || roundsUsed >= MAX_REFACTOR_ROUNDS) {
			return;
		}
		roundsUsed++;
		return {
			entries: [
				{
					type: "custom_message" as const,
					customType: "jscpd.duplicates",
					content: formatMessage(report, MIN_TOKENS),
					display: true,
					details: { minTokens: MIN_TOKENS, clones: relevant },
				},
			],
			continue: true,
		};
	});

	pi.on("agent_settled", () => {
		roundsUsed = 0;
		written.clear();
		scanPromise = null;
		lastSignature = "";
	});

	pi.on("session_shutdown", () => {
		if (debounceTimer) clearTimeout(debounceTimer);
	});

	pi.registerCommand("jscpd", {
		description: "Scan the project for duplicated code now (optionally: /jscpd <minTokens>)",
		handler: async (arg, ctx) => {
			const minTokens = Number.parseInt(arg ?? "", 10) || MIN_TOKENS;
			notify(ctx, `jscpd: scanning ${ctx.cwd} ...`, "info");
			try {
				const result = await runScan(pi.exec, {
					cwd: ctx.cwd,
					formats: [],
					minTokens,
					timeoutMs: SCAN_TIMEOUT_MS,
					allFormats: true,
				});
				if (result.clones.length === 0) {
					notify(ctx, `jscpd: no duplication found (min ${minTokens} tokens)`, "info");
					return;
				}
				notify(ctx, `jscpd: ${result.clones.length} cloned block(s) found, reporting to the agent`, "warning");
				pi.sendMessage(
					{
						customType: "jscpd.duplicates",
						content: formatMessage(result, minTokens, { manual: true }),
						display: true,
					},
					{ triggerTurn: true },
				);
			} catch (err) {
				notify(ctx, `jscpd: scan failed — ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
