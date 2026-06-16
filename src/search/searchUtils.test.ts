import * as path from "node:path"
import { describe, expect, it } from "vitest"
import {
	breadcrumbFromIndex,
	buildSymbolIndex,
	extractSymbol,
	groupByFile,
	normalizeGlob,
	splitLines,
	splitPatterns,
} from "./searchUtils"
import type { SearchMatch } from "./types"

describe("splitLines", () => {
	it("returns complete lines and holds back the incomplete remainder", () => {
		const { lines, remainder } = splitLines("", "line1\nline2\npartial")
		expect(lines).toEqual(["line1", "line2"])
		expect(remainder).toBe("partial")
	})

	it("assembles a line split across two chunks", () => {
		const first = splitLines("", "start-of-very-long-")
		const second = splitLines(first.remainder, "line\nnext\n")
		expect(second.lines).toEqual(["start-of-very-long-line", "next"])
		expect(second.remainder).toBe("")
	})

	it("handles chunks with no newline", () => {
		const { lines, remainder } = splitLines("already", "-buffered")
		expect(lines).toEqual([])
		expect(remainder).toBe("already-buffered")
	})
})

describe("normalizeGlob", () => {
	it("leaves already-anchored patterns alone", () => {
		expect(normalizeGlob("**/src/**")).toBe("**/src/**")
		expect(normalizeGlob("/absolute/path")).toBe("/absolute/path")
	})

	it("wraps bare directory names with **/ and /**", () => {
		expect(normalizeGlob("src")).toBe("**/src/**")
		expect(normalizeGlob("src/search")).toBe("**/src/search/**")
	})

	it("anchors patterns with path separators", () => {
		expect(normalizeGlob("src/**")).toBe("**/src/**")
		expect(normalizeGlob("test/**")).toBe("**/test/**")
	})

	it("converts trailing /* to /** for recursive matching", () => {
		expect(normalizeGlob("packages/m2-typings/*")).toBe(
			"**/packages/m2-typings/**",
		)
	})

	it("leaves basename-only wildcard patterns alone", () => {
		expect(normalizeGlob("*.ts")).toBe("*.ts")
		expect(normalizeGlob("*.test.ts")).toBe("*.test.ts")
	})
})

describe("splitPatterns", () => {
	it("splits comma-separated globs and trims whitespace", () => {
		expect(splitPatterns("src/**, , *.ts")).toEqual(["src/**", "*.ts"])
	})

	it("returns empty array for blank input", () => {
		expect(splitPatterns("  ,  , ")).toEqual([])
	})
})

describe("extractSymbol", () => {
	it("extracts TypeScript function names", () => {
		expect(extractSymbol("async function fetchData() {")).toBe("fn fetchData")
		expect(extractSymbol("export async function fetchData() {")).toBe(
			"fetchData",
		)
	})

	it("extracts Rust function names", () => {
		expect(extractSymbol("fn search_workspace() {")).toBe("fn search_workspace")
		expect(extractSymbol("pub fn search_workspace() {")).toBe(
			"search_workspace",
		)
	})

	it("extracts class names", () => {
		expect(extractSymbol("export class SearchEngine {")).toBe("SearchEngine")
	})

	it("returns null for non-symbol lines", () => {
		expect(extractSymbol("const x = 1;")).toBeNull()
	})
})

describe("buildSymbolIndex", () => {
	it("collects symbol declarations with their line index", () => {
		const lines = [
			"export function outer() {",
			"  const x = 1;",
			"export class Inner {",
		]
		expect(buildSymbolIndex(lines)).toEqual([
			{ line: 0, symbol: "outer" },
			{ line: 2, symbol: "Inner" },
		])
	})

	it("skips lines without a symbol", () => {
		expect(buildSymbolIndex(["const x = 1;", "  return y;"])).toEqual([])
	})
})

describe("breadcrumbFromIndex", () => {
	it("joins symbols above the match line", () => {
		const index = buildSymbolIndex([
			"export function outer() {",
			"  return fulltab_marker;",
		])
		expect(breadcrumbFromIndex(index, 2)).toBe("outer")
	})

	it("returns only the nearest 4 symbols, top-to-bottom", () => {
		const index = [
			{ line: 0, symbol: "a" },
			{ line: 1, symbol: "b" },
			{ line: 2, symbol: "c" },
			{ line: 3, symbol: "d" },
			{ line: 4, symbol: "e" },
		]
		// match on line 6 (1-based) → all 5 are above; keep nearest 4
		expect(breadcrumbFromIndex(index, 6)).toBe("b › c › d › e")
	})

	it("excludes symbols at or below the match line", () => {
		const index = [
			{ line: 0, symbol: "a" },
			{ line: 5, symbol: "b" },
		]
		// match on line 3 (1-based, 0-based index 2): only `a` is strictly above
		expect(breadcrumbFromIndex(index, 3)).toBe("a")
	})
})

describe("groupByFile", () => {
	it("groups matches and computes relative paths", () => {
		const root = path.join("/workspace", "project")
		const fileA = path.join(root, "src", "a.ts")
		const fileB = path.join(root, "src", "b.ts")
		const matches: SearchMatch[] = [
			{
				id: 0,
				file: fileA,
				relativePath: fileA,
				line: 1,
				column: 0,
				lineText: "alpha",
				matchStart: 0,
				matchEnd: 5,
				contextBefore: [],
				contextAfter: [],
				breadcrumb: "",
			},
			{
				id: 1,
				file: fileA,
				relativePath: fileA,
				line: 2,
				column: 0,
				lineText: "beta",
				matchStart: 0,
				matchEnd: 4,
				contextBefore: [],
				contextAfter: [],
				breadcrumb: "",
			},
			{
				id: 2,
				file: fileB,
				relativePath: fileB,
				line: 1,
				column: 0,
				lineText: "gamma",
				matchStart: 0,
				matchEnd: 5,
				contextBefore: [],
				contextAfter: [],
				breadcrumb: "",
			},
		]

		const grouped = groupByFile(matches, root)
		expect(grouped).toHaveLength(2)

		const a = grouped.find((entry) => entry.fileName === "a.ts")
		expect(a?.relativePath).toBe(path.join("src", "a.ts"))
		expect(a?.directory).toBe("src")
		expect(a?.matches).toHaveLength(2)

		const b = grouped.find((entry) => entry.fileName === "b.ts")
		expect(b?.matches).toHaveLength(1)
	})
})
