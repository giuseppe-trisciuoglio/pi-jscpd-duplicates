/**
 * Pure duplicate-detection logic, decoupled from the host agent runtime so it
 * can be unit-tested and reused (e.g. by a future standalone CLI wrapper).
 *
 * The only external dependency is an `exec` function, injected by the caller,
 * that spawns a process and returns stdout/stderr/exit code.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** Maps a file extension to the jscpd format name it belongs to. */
const EXT_TO_FORMAT: Record<string, string> = {
	ts: "typescript",
	tsx: "typescript",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	py: "python",
	java: "java",
	kt: "kotlin",
	kts: "kotlin",
	swift: "swift",
	go: "go",
	rs: "rust",
	rb: "ruby",
	php: "php",
	cs: "csharp",
	scala: "scala",
	c: "c",
	h: "c",
	cpp: "cpp",
	cc: "cpp",
	cxx: "cpp",
	hpp: "cpp",
	sh: "bash",
	bash: "bash",
};

/**
 * jscpd's glob ignore does not reliably match dot-directories like `.git`
 * (observed with jscpd 5.3.3: a brace pattern listing `.git` among other
 * directories still leaks git hook samples into the report). Ignore patterns
 * are therefore listed explicitly, and a post-parse segment filter provides
 * a second layer of defense.
 */
const DEFAULT_IGNORE = [
	"**/.git/**",
	"**/node_modules/**",
	"**/dist/**",
	"**/build/**",
	"**/out/**",
	"**/coverage/**",
	"**/.next/**",
	"**/.nuxt/**",
	"**/.cache/**",
	"**/vendor/**",
	"**/target/**",
	"**/.scratch/**",
].join(",");

/** Path segments that mark a file as generated or vendored, never first-party. */
const JUNK_SEGMENTS = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	"dist",
	"build",
	"out",
	"coverage",
	"vendor",
	"target",
	".next",
	".nuxt",
	".cache",
	".scratch",
]);

function hasJunkSegment(relFile: string): boolean {
	return relFile.split("/").some((part) => JUNK_SEGMENTS.has(part));
}

/**
 * Header lines that cannot be extracted into shared code: module/package
 * declarations and imports. Two files sharing the same imports is not
 * duplication, yet jscpd counts them (e.g. Java tests importing the same
 * JUnit/Mockito/Spring symbols easily exceed 50 tokens).
 */
const JVM_HEADER = /^(package|import)\s[^;{]*;?$/;
const HEADER_LINE: Record<string, RegExp> = {
	java: JVM_HEADER,
	kotlin: JVM_HEADER,
	scala: JVM_HEADER,
	csharp: /^(using\s[^;{(]*;|namespace\s[^{;]*;)$/,
	python: /^(import\s.+|from\s+\S+\s+import\s.+)$/,
	typescript: /^(import\s.*from\s+["'][^"']+["'];?|import\s+["'][^"']+["'];?)$/,
	javascript: /^(import\s.*from\s+["'][^"']+["'];?|import\s+["'][^"']+["'];?)$/,
};
const COMMENT_LINE = /^(\/\/|\/\*|\*|\*\/|#)/;
const TOKEN = /[A-Za-z_$][\w$]*|\d[\w.]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S/g;

/** Approximate token count of a fragment once header and comment lines are removed. */
export function meaningfulTokens(fragment: string, format: string): number {
	const header = HEADER_LINE[format];
	let count = 0;
	for (const raw of fragment.split("\n")) {
		const line = raw.trim();
		if (line.length === 0 || COMMENT_LINE.test(line)) continue;
		if (header?.test(line)) continue;
		count += line.match(TOKEN)?.length ?? 0;
	}
	return count;
}

/**
 * True when a clone is only package/import/comment boilerplate: what is left
 * after stripping those lines falls below the detection threshold. Clones
 * without a fragment are kept, since nothing can be proven about them.
 */
export function isHeaderOnly(clone: Clone, minTokens: number): boolean {
	if (!clone.fragment || !HEADER_LINE[clone.format]) return false;
	return meaningfulTokens(clone.fragment, clone.format) < minTokens;
}

export interface ExecResultLike {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

export type ExecFn = (
	command: string,
	args: string[],
	options: { cwd?: string; timeout?: number },
) => Promise<ExecResultLike>;

export interface CloneRange {
	/** Path relative to the scanned project root, POSIX separators. */
	file: string;
	startLine: number;
	endLine: number;
}

export interface Clone {
	a: CloneRange;
	b: CloneRange;
	lines: number;
	tokens: number;
	format: string;
	fragment: string;
}

export interface ScanResult {
	clones: Clone[];
	root: string;
}

export function extensionToFormat(ext: string): string | undefined {
	return EXT_TO_FORMAT[ext.toLowerCase()];
}

/** Distinct jscpd format names covering the given file paths. */
export function collectFormats(files: string[]): string[] {
	const formats = new Set<string>();
	for (const file of files) {
		const format = extensionToFormat(path.extname(file).slice(1));
		if (format) formats.add(format);
	}
	return [...formats];
}

interface RawClone {
	firstFile: { name: string; startLoc?: { line?: number }; endLoc?: { line?: number } };
	secondFile: { name: string; startLoc?: { line?: number }; endLoc?: { line?: number } };
	lines?: number;
	tokens?: number;
	format?: string;
	fragment?: string;
}

export function parseReport(json: string, root: string): Clone[] {
	const report = JSON.parse(json) as { duplicates?: Record<string, RawClone> | RawClone[] };
	const raw = Array.isArray(report.duplicates)
		? report.duplicates
		: Object.values(report.duplicates ?? {});
	const clones: Clone[] = [];
	for (const c of raw) {
		if (!c.firstFile?.name || !c.secondFile?.name) continue;
		clones.push({
			a: {
				file: normalizeName(c.firstFile.name, c.format),
				startLine: c.firstFile.startLoc?.line ?? 0,
				endLine: c.firstFile.endLoc?.line ?? 0,
			},
			b: {
				file: normalizeName(c.secondFile.name, c.format),
				startLine: c.secondFile.startLoc?.line ?? 0,
				endLine: c.secondFile.endLoc?.line ?? 0,
			},
			lines: c.lines ?? 0,
			tokens: c.tokens ?? 0,
			format: c.format ?? "unknown",
			fragment: c.fragment ?? "",
		});
	}
	return clones;
}

/**
 * jscpd sometimes appends the format to the reported file name (e.g.
 * `CHANGELOG.md:markdown`) when several formats share a relative path.
 * Strip that suffix so names resolve to real paths again.
 */
function normalizeName(name: string, format: string | undefined): string {
	const rel = name.replace(/[\\/]/g, "/");
	if (format && rel.endsWith(`:${format}`)) {
		return rel.slice(0, -format.length - 1);
	}
	return rel;
}

/**
 * Keeps only clones where at least one side is a file the agent wrote this
 * turn. Re-enters duplication the agent created or reintroduced; does not
 * nag about pre-existing duplication it never touched. When only one side is
 * a written file, the written file is oriented first for readability.
 */
export function filterInvolving(clones: Clone[], writtenAbs: Set<string>, root: string): Clone[] {
	const out: Clone[] = [];
	for (const clone of clones) {
		const absA = path.resolve(root, clone.a.file);
		const absB = path.resolve(root, clone.b.file);
		const aWritten = writtenAbs.has(absA);
		const bWritten = writtenAbs.has(absB);
		if (!aWritten && !bWritten) continue;
		out.push(aWritten ? clone : { ...clone, a: clone.b, b: clone.a });
	}
	out.sort((x, y) => y.tokens - x.tokens);
	return out;
}

export interface RunScanOptions {
	cwd: string;
	formats: string[];
	minTokens: number;
	timeoutMs: number;
	ignore?: string;
	/** Extra CLI flags, used by the manual command to scan all formats. */
	allFormats?: boolean;
}

/**
 * Runs jscpd over the project root, writing the report to a temp directory
 * outside the tree so the report cannot be scanned as a source file.
 */
export async function runScan(exec: ExecFn, opts: RunScanOptions): Promise<ScanResult> {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "jscpd-ext-"));
	try {
		const args = [
			"--yes",
			"jscpd",
			".",
			"--reporters",
			"json",
			"--output",
			tmp,
			"--silent",
			"--min-tokens",
			String(opts.minTokens),
			"--ignore",
			opts.ignore ?? DEFAULT_IGNORE,
		];
		if (!opts.allFormats && opts.formats.length > 0) {
			args.push("--format", opts.formats.join(","));
		}
		const res = await exec("npx", args, { cwd: opts.cwd, timeout: opts.timeoutMs });
		if (res.killed) {
			throw new Error(`jscpd timed out after ${opts.timeoutMs} ms`);
		}
		const reportPath = path.join(tmp, "jscpd-report.json");
		const json = await fs.readFile(reportPath, "utf8");
		// Second junk layer: drops clones involving vendored/generated paths even
		// if the glob ignore missed them (see comment on DEFAULT_IGNORE). Then
		// drops clones made only of imports, which have nothing to extract.
		const clones = parseReport(json, opts.cwd).filter(
			(c) =>
				!hasJunkSegment(c.a.file) && !hasJunkSegment(c.b.file) && !isHeaderOnly(c, opts.minTokens),
		);
		return { clones, root: opts.cwd };
	} finally {
		await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
	}
}

/** Stable fingerprint of a clone set, used to detect no-op refactor loops. */
export function signature(result: ScanResult): string {
	return result.clones
		.map((c) => {
			const pair = [`${c.a.file}:${c.a.startLine}-${c.a.endLine}`, `${c.b.file}:${c.b.startLine}-${c.b.endLine}`];
			pair.sort();
			return pair.join("<->");
		})
		.sort()
		.join("|");
}

const MAX_CLONES_IN_MESSAGE = 6;
const FRAGMENT_LINES = 2;
const FRAGMENT_LINE_MAX = 100;

/** Builds the plain-text report the agent receives when duplication is found. */
export function formatMessage(
	result: ScanResult,
	minTokens: number,
	opts: { manual?: boolean } = {},
): string {
	const lines: string[] = [];
	if (opts.manual) {
		lines.push(`Manual duplicate-code scan (jscpd, minimum ${minTokens} tokens) found ${result.clones.length} cloned block(s).`);
		lines.push(
			"Refactor only first-party source code; leave vendored, generated or third-party files untouched.",
		);
	} else {
		lines.push(
			`Duplicate-code check (jscpd, minimum ${minTokens} tokens) found ${result.clones.length} cloned block(s) in files written this turn.`,
		);
		lines.push(
			"Remove the duplication by extracting the shared logic into a single module/function and updating imports.",
			"Keep behavior identical. When done, finish your current task normally.",
		);
	}
	lines.push("");
	const shown = result.clones.slice(0, MAX_CLONES_IN_MESSAGE);
	shown.forEach((c, i) => {
		lines.push(
			`${i + 1}. ${c.a.file}:${c.a.startLine}-${c.a.endLine}  <->  ${c.b.file}:${c.b.startLine}-${c.b.endLine}  (${c.lines} lines, ${c.tokens} tokens, ${c.format})`,
		);
		const head = c.fragment
			.split("\n")
			.slice(0, FRAGMENT_LINES)
			.map((l) => l.trim().slice(0, FRAGMENT_LINE_MAX))
			.filter((l) => l.length > 0)
			.map((l) => `   | ${l}`);
		lines.push(...head);
	});
	if (result.clones.length > shown.length) {
		lines.push(`(... and ${result.clones.length - shown.length} more)`);
	}
	return lines.join("\n");
}
