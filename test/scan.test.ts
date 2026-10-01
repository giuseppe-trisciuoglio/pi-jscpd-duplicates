import { describe, expect, it, vi } from "vitest";
import * as path from "node:path";

import {
	collectFormats,
	extensionToFormat,
	filterInvolving,
	formatMessage,
	isHeaderOnly,
	meaningfulTokens,
	parseReport,
	runScan,
	signature,
	type Clone,
	type ExecFn,
	type ScanResult,
} from "../src/scan.ts";

const fsState = vi.hoisted(() => ({ report: "" }));

vi.mock("node:fs/promises", async () => {
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	return {
		...actual,
		readFile: vi.fn(async (p: unknown, options?: unknown) => {
			if (String(p).endsWith("jscpd-report.json")) return fsState.report;
			return actual.readFile(p as Parameters<typeof actual.readFile>[0], options as never);
		}),
		mkdtemp: vi.fn(async () => "/tmp/jscpd-ext-test"),
		rm: vi.fn(async () => undefined),
	};
});

describe("extensionToFormat", () => {
	it("maps known extensions to canonical jscpd formats", () => {
		expect(extensionToFormat("ts")).toBe("typescript");
		expect(extensionToFormat("TSX")).toBe("typescript");
		expect(extensionToFormat("py")).toBe("python");
		expect(extensionToFormat("java")).toBe("java");
		expect(extensionToFormat("kt")).toBe("kotlin");
		expect(extensionToFormat("cs")).toBe("csharp");
		expect(extensionToFormat("h")).toBe("c");
		expect(extensionToFormat("cpp")).toBe("cpp");
		expect(extensionToFormat("hpp")).toBe("cpp");
		expect(extensionToFormat("sh")).toBe("bash");
	});

	it("returns undefined for unsupported extensions", () => {
		expect(extensionToFormat("md")).toBeUndefined();
		expect(extensionToFormat("")).toBeUndefined();
		expect(extensionToFormat("png")).toBeUndefined();
	});
});

describe("collectFormats", () => {
	it("returns distinct format names covering the given files", () => {
		expect(collectFormats(["a.ts", "b.tsx", "c.ts"])).toEqual(["typescript"]);
		expect(collectFormats(["a.py", "b.java", "c.go"]).sort()).toEqual(["go", "java", "python"]);
	});

	it("skips unsupported files", () => {
		expect(collectFormats(["a.md", "b.txt"])).toEqual([]);
		expect(collectFormats(["a.ts", "b.md"])).toEqual(["typescript"]);
	});
});

describe("parseReport", () => {
	const root = "/repo";

	it("returns an empty array when duplicates is missing", () => {
		expect(parseReport("{}", root)).toEqual([]);
		expect(parseReport('{"duplicates":null}', root)).toEqual([]);
	});

	it("parses clones from an object map and strips the :format suffix", () => {
		const json = JSON.stringify({
			statistics: { total: { lines: 100, tokens: 500, sources: 2, clones: 1, percentage: 5 } },
			duplicates: {
				"0": {
					firstFile: { name: "src/a.ts", startLoc: { line: 10 }, endLoc: { line: 25 } },
					secondFile: { name: "src/b.ts:typescript", startLoc: { line: 50 }, endLoc: { line: 65 } },
					lines: 16,
					tokens: 120,
					format: "typescript",
					fragment: "const x = 1;\nconst y = 2;\n",
				},
			},
		});
		const clones = parseReport(json, root);
		expect(clones).toHaveLength(1);
		const c = clones[0]!;
		expect(c.a.file).toBe("src/a.ts");
		expect(c.a.startLine).toBe(10);
		expect(c.a.endLine).toBe(25);
		expect(c.b.file).toBe("src/b.ts");
		expect(c.b.startLine).toBe(50);
		expect(c.b.endLine).toBe(65);
		expect(c.lines).toBe(16);
		expect(c.tokens).toBe(120);
		expect(c.format).toBe("typescript");
		expect(c.fragment).toContain("const x = 1");
	});

	it("does not strip a suffix that does not match the format", () => {
		const json = JSON.stringify({
			duplicates: {
				"0": {
					firstFile: { name: "CHANGELOG.md", startLoc: { line: 1 }, endLoc: { line: 3 } },
					secondFile: { name: "README.md", startLoc: { line: 5 }, endLoc: { line: 7 } },
					format: "markdown",
					lines: 2,
					tokens: 60,
					fragment: "# heading\nbody line\n",
				},
			},
		});
		const clones = parseReport(json, root);
		expect(clones[0]!.a.file).toBe("CHANGELOG.md");
		expect(clones[0]!.b.file).toBe("README.md");
	});

	it("normalizes windows-style separators to POSIX", () => {
		const json = JSON.stringify({
			duplicates: {
				"0": {
					firstFile: { name: "src\\a.ts", startLoc: { line: 1 }, endLoc: { line: 1 } },
					secondFile: { name: "src\\b.ts", startLoc: { line: 1 }, endLoc: { line: 1 } },
					format: "typescript",
					lines: 1,
					tokens: 60,
					fragment: "x",
				},
			},
		});
		const clones = parseReport(json, root);
		expect(clones[0]!.a.file).toBe("src/a.ts");
		expect(clones[0]!.b.file).toBe("src/b.ts");
	});

	it("drops clones that miss one of the two file names", () => {
		const json = JSON.stringify({
			duplicates: {
				"0": {
					firstFile: { name: "src/a.ts", startLoc: { line: 1 }, endLoc: { line: 1 } },
					secondFile: { name: "", startLoc: { line: 1 }, endLoc: { line: 1 } },
					format: "typescript",
					lines: 1,
					tokens: 60,
					fragment: "x",
				},
			},
		});
		expect(parseReport(json, root)).toEqual([]);
	});
});

describe("meaningfulTokens", () => {
	it("ignores blank lines, comments and Java/Kotlin/Scala imports", () => {
		const fragment = [
			"package com.example;",
			"",
			"import org.junit.jupiter.api.Test;",
			"import org.junit.jupiter.api.Assertions.assertEquals;",
			"// a comment line",
			"public void shouldDoSomething() {",
			"    assertEquals(1, 1);",
			"}",
		].join("\n");
		expect(meaningfulTokens(fragment, "java")).toBeGreaterThan(0);
		expect(meaningfulTokens(fragment, "java")).toBeLessThan(meaningfulTokens(fragment, "unknown"));
	});

	it("counts nothing when the fragment is only header lines", () => {
		const fragment = [
			"package com.example;",
			"import org.junit.jupiter.api.Test;",
			"import org.junit.jupiter.api.Assertions.assertEquals;",
		].join("\n");
		expect(meaningfulTokens(fragment, "java")).toBe(0);
	});
});

describe("isHeaderOnly", () => {
	const make = (fragment: string, format: string): Clone => ({
		a: { file: "a.ts", startLine: 1, endLine: 1 },
		b: { file: "b.ts", startLine: 1, endLine: 1 },
		lines: 10,
		tokens: 80,
		format,
		fragment,
	});

	it("drops a Java fragment made of only imports and comments", () => {
		const c = make(
			[
				"package com.example;",
				"",
				"import org.junit.jupiter.api.Test;",
				"import org.junit.jupiter.api.Assertions.assertEquals;",
				"import org.mockito.Mockito;",
				"// trailing comment",
			].join("\n"),
			"java",
		);
		expect(isHeaderOnly(c, 50)).toBe(true);
	});

	it("keeps a Java fragment that includes logic above the threshold", () => {
		const body = "x = 1; y = 2; z = 3; w = 4; v = 5; u = 6; t = 7; s = 8; r = 9; q = 10;".repeat(5);
		const c = make(`package com.example;\n${body}`, "java");
		expect(isHeaderOnly(c, 50)).toBe(false);
	});

	it("keeps the clone when format has no header rule (no evidence)", () => {
		const c = make("anything", "ruby");
		expect(isHeaderOnly(c, 50)).toBe(false);
	});

	it("keeps the clone when the fragment is empty (nothing can be proven)", () => {
		const c = make("", "java");
		expect(isHeaderOnly(c, 50)).toBe(false);
	});
});

describe("filterInvolving", () => {
	const root = "/repo";
	const writtenAbs = new Set([path.resolve(root, "src/new.ts"), path.resolve(root, "src/other.ts")]);

	const clone = (aFile: string, bFile: string): Clone => ({
		a: { file: aFile, startLine: 1, endLine: 10 },
		b: { file: bFile, startLine: 20, endLine: 30 },
		lines: 10,
		tokens: 80,
		format: "typescript",
		fragment: "x",
	});

	it("keeps clones where at least one side was written this turn", () => {
		const clones = [
			clone("src/old.ts", "src/older.ts"),
			clone("src/new.ts", "src/old.ts"),
		];
		const out = filterInvolving(clones, writtenAbs, root);
		expect(out).toHaveLength(1);
		expect(out[0]!.a.file).toBe("src/new.ts");
	});

	it("orients the clone with the freshly written file first", () => {
		const c = clone("src/old.ts", "src/new.ts");
		const out = filterInvolving([c], writtenAbs, root);
		expect(out[0]!.a.file).toBe("src/new.ts");
		expect(out[0]!.b.file).toBe("src/old.ts");
	});

	it("drops clones that do not involve any written file", () => {
		const out = filterInvolving([clone("src/old.ts", "src/older.ts")], writtenAbs, root);
		expect(out).toEqual([]);
	});

	it("sorts the result by descending token count", () => {
		const big = clone("src/new.ts", "src/old.ts");
		big.tokens = 500;
		const small = clone("src/other.ts", "src/somewhere.ts");
		small.tokens = 100;
		const out = filterInvolving([small, big], writtenAbs, root);
		expect(out[0]!.tokens).toBe(500);
		expect(out[1]!.tokens).toBe(100);
	});
});

describe("signature", () => {
	it("is independent of clone order", () => {
		const root = "/repo";
		const c1: Clone = {
			a: { file: "a.ts", startLine: 1, endLine: 10 },
			b: { file: "b.ts", startLine: 5, endLine: 15 },
			lines: 10, tokens: 80, format: "typescript", fragment: "x",
		};
		const c2: Clone = {
			a: { file: "c.ts", startLine: 1, endLine: 10 },
			b: { file: "d.ts", startLine: 5, endLine: 15 },
			lines: 10, tokens: 80, format: "typescript", fragment: "x",
		};
		const r1: ScanResult = { root, clones: [c1, c2] };
		const r2: ScanResult = { root, clones: [c2, c1] };
		expect(signature(r1)).toBe(signature(r2));
	});

	it("changes when any side of any pair changes", () => {
		const root = "/repo";
		const base: Clone = {
			a: { file: "a.ts", startLine: 1, endLine: 10 },
			b: { file: "b.ts", startLine: 5, endLine: 15 },
			lines: 10, tokens: 80, format: "typescript", fragment: "x",
		};
		const shifted: Clone = { ...base, a: { ...base.a, startLine: 2 } };
		const r1: ScanResult = { root, clones: [base] };
		const r2: ScanResult = { root, clones: [shifted] };
		expect(signature(r1)).not.toBe(signature(r2));
	});
});

describe("formatMessage", () => {
	const root = "/repo";
	const makeResult = (clones: Clone[]): ScanResult => ({ root, clones });

	it("includes the count and a refactor instruction for the automatic mode", () => {
		const result = makeResult([
			{
				a: { file: "src/new.ts", startLine: 1, endLine: 10 },
				b: { file: "src/old.ts", startLine: 20, endLine: 30 },
				lines: 10, tokens: 80, format: "typescript",
				fragment: "const x = 1;\nconst y = 2;",
			},
		]);
		const msg = formatMessage(result, 50);
		expect(msg).toContain("Duplicate-code check");
		expect(msg).toContain("1 cloned block");
		expect(msg).toContain("src/new.ts:1-10");
		expect(msg).toContain("src/old.ts:20-30");
		expect(msg).toContain("const x = 1");
	});

	it("uses the manual-mode phrasing when opts.manual is true", () => {
		const result = makeResult([]);
		const msg = formatMessage(result, 50, { manual: true });
		expect(msg).toContain("Manual duplicate-code scan");
		expect(msg).toContain("0 cloned block");
	});

	it("truncates very long fragment lines", () => {
		const long = "x".repeat(500);
		const c: Clone = {
			a: { file: "a.ts", startLine: 1, endLine: 2 },
			b: { file: "b.ts", startLine: 1, endLine: 2 },
			lines: 2, tokens: 80, format: "typescript", fragment: long,
		};
		const msg = formatMessage(makeResult([c]), 50);
		expect(msg).toMatch(/\| x{80,100}/);
	});

	it("includes a tail summary when there are more than the displayed clones", () => {
		const clones: Clone[] = [];
		for (let i = 0; i < 10; i++) {
			clones.push({
				a: { file: `a${i}.ts`, startLine: 1, endLine: 2 },
				b: { file: `b${i}.ts`, startLine: 1, endLine: 2 },
				lines: 2, tokens: 80, format: "typescript", fragment: "x",
			});
		}
		const msg = formatMessage(makeResult(clones), 50);
		expect(msg).toContain("... and 4 more");
	});
});

describe("runScan", () => {
	const root = "/repo";

	it("invokes npx jscpd with the right arguments and parses the report", async () => {
		fsState.report = JSON.stringify({
			duplicates: {
				"0": {
					firstFile: { name: "src/a.ts", startLoc: { line: 1 }, endLoc: { line: 15 } },
					secondFile: { name: "src/b.ts", startLoc: { line: 1 }, endLoc: { line: 15 } },
					lines: 15, tokens: 120, format: "typescript",
					fragment:
						"const alpha = 1;\nconst beta = 2;\nconst gamma = 3;\nconst delta = 4;\nconst epsilon = 5;\nconst zeta = 6;\nconst eta = 7;\nconst theta = 8;\nconst iota = 9;\nconst kappa = 10;\nconst lambda = 11;\nconst mu = 12;\nconst nu = 13;\nconst xi = 14;\nconst omicron = 15;\n",
				},
			},
		});
		const calls: Array<{ cmd: string; args: string[]; opts: { cwd?: string; timeout?: number } }> = [];
		const exec: ExecFn = async (cmd, args, opts) => {
			calls.push({ cmd, args, opts });
			return { stdout: "", stderr: "", code: 0, killed: false };
		};
		const result = await runScan(exec, {
			cwd: root,
			formats: ["typescript"],
			minTokens: 50,
			timeoutMs: 10000,
		});
		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(call.cmd).toBe("npx");
		expect(call.args).toContain("--yes");
		expect(call.args).toContain("jscpd");
		expect(call.args).toContain(".");
		expect(call.args).toContain("--reporters");
		expect(call.args).toContain("json");
		expect(call.args).toContain("--format");
		expect(call.args).toContain("typescript");
		expect(call.opts.cwd).toBe(root);
		expect(call.opts.timeout).toBe(10000);
		expect(result.clones).toHaveLength(1);
		expect(result.clones[0]!.a.file).toBe("src/a.ts");
	});

	it("throws when jscpd is killed by the timeout", async () => {
		const exec: ExecFn = async () => ({ stdout: "", stderr: "", code: 0, killed: true });
		await expect(
			runScan(exec, { cwd: root, formats: ["typescript"], minTokens: 50, timeoutMs: 1000 }),
		).rejects.toThrow(/timed out/);
	});

	it("drops junk-segment clones even if the glob ignore missed them", async () => {
		fsState.report = JSON.stringify({
			duplicates: {
				"0": {
					firstFile: { name: ".git/hooks/pre-commit", startLoc: { line: 1 }, endLoc: { line: 5 } },
					secondFile: { name: ".git/hooks/pre-receive", startLoc: { line: 1 }, endLoc: { line: 5 } },
					lines: 5, tokens: 80, format: "typescript", fragment: "x",
				},
			},
		});
		const exec: ExecFn = async () => ({ stdout: "", stderr: "", code: 0, killed: false });
		const result = await runScan(exec, {
			cwd: root,
			formats: ["typescript"],
			minTokens: 50,
			timeoutMs: 10000,
		});
		expect(result.clones).toEqual([]);
	});
});