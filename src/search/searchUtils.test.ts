import assert from "node:assert"
import * as path from "node:path"
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
		assert.deepEqual(lines, ["line1", "line2"])
		assert.strictEqual(remainder, "partial")
	})

	it("assembles a line split across two chunks", () => {
		const first = splitLines("", "start-of-very-long-")
		const second = splitLines(first.remainder, "line\nnext\n")
		assert.deepEqual(second.lines, ["start-of-very-long-line", "next"])
		assert.strictEqual(second.remainder, "")
	})

	it("handles chunks with no newline", () => {
		const { lines, remainder } = splitLines("already", "-buffered")
		assert.deepEqual(lines, [])
		assert.strictEqual(remainder, "already-buffered")
	})
})

describe("normalizeGlob", () => {
	it("leaves already-anchored patterns alone", () => {
		assert.strictEqual(normalizeGlob("**/src/**"), "**/src/**")
		assert.strictEqual(normalizeGlob("/absolute/path"), "/absolute/path")
	})

	it("wraps bare directory names with **/ and /**", () => {
		assert.strictEqual(normalizeGlob("src"), "**/src/**")
		assert.strictEqual(normalizeGlob("src/search"), "**/src/search/**")
	})

	it("anchors patterns with path separators", () => {
		assert.strictEqual(normalizeGlob("src/**"), "**/src/**")
		assert.strictEqual(normalizeGlob("test/**"), "**/test/**")
	})

	it("converts trailing /* to /** for recursive matching", () => {
		assert.strictEqual(
			normalizeGlob("packages/m2-typings/*"),
			"**/packages/m2-typings/**",
		)
	})

	it("leaves basename-only wildcard patterns alone", () => {
		assert.strictEqual(normalizeGlob("*.ts"), "*.ts")
		assert.strictEqual(normalizeGlob("*.test.ts"), "*.test.ts")
	})
})

describe("splitPatterns", () => {
	it("splits comma-separated globs and trims whitespace", () => {
		assert.deepEqual(splitPatterns("src/**, , *.ts"), ["src/**", "*.ts"])
	})

	it("returns empty array for blank input", () => {
		assert.deepEqual(splitPatterns("  ,  , "), [])
	})
})

describe("extractSymbol", () => {
	it("extracts TypeScript function names", () => {
		assert.strictEqual(
			extractSymbol("async function fetchData() {"),
			"fn fetchData",
		)
		assert.strictEqual(
			extractSymbol("export async function fetchData() {"),
			"fetchData",
		)
	})

	it("extracts Rust function names", () => {
		assert.strictEqual(
			extractSymbol("fn search_workspace() {"),
			"fn search_workspace",
		)
		assert.strictEqual(
			extractSymbol("pub fn search_workspace() {"),
			"search_workspace",
		)
	})

	it("extracts class names", () => {
		assert.strictEqual(
			extractSymbol("export class SearchEngine {"),
			"SearchEngine",
		)
	})

	it("returns null for non-symbol lines", () => {
		assert.strictEqual(extractSymbol("const x = 1;"), null)
	})
})

describe("buildSymbolIndex", () => {
	it("collects symbol declarations with their line index", () => {
		const lines = [
			"export function outer() {",
			"  const x = 1;",
			"export class Inner {",
		]
		assert.deepEqual(buildSymbolIndex(lines), [
			{ line: 0, symbol: "outer" },
			{ line: 2, symbol: "Inner" },
		])
	})

	it("skips lines without a symbol", () => {
		assert.deepEqual(buildSymbolIndex(["const x = 1;", "  return y;"]), [])
	})
})

describe("breadcrumbFromIndex", () => {
	it("joins symbols above the match line", () => {
		const index = buildSymbolIndex([
			"export function outer() {",
			"  return fulltab_marker;",
		])
		assert.strictEqual(breadcrumbFromIndex(index, 2), "outer")
	})

	it("returns only the nearest 4 symbols, top-to-bottom", () => {
		const index = [
			{ line: 0, symbol: "a" },
			{ line: 1, symbol: "b" },
			{ line: 2, symbol: "c" },
			{ line: 3, symbol: "d" },
			{ line: 4, symbol: "e" },
		]
		assert.strictEqual(breadcrumbFromIndex(index, 6), "b › c › d › e")
	})

	it("excludes symbols at or below the match line", () => {
		const index = [
			{ line: 0, symbol: "a" },
			{ line: 5, symbol: "b" },
		]
		assert.strictEqual(breadcrumbFromIndex(index, 3), "a")
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
		assert.strictEqual(grouped.length, 2)

		const a = grouped.find((entry) => entry.fileName === "a.ts")
		assert.strictEqual(a?.relativePath, path.join("src", "a.ts"))
		assert.strictEqual(a?.directory, "src")
		assert.strictEqual(a?.matches.length, 2)

		const b = grouped.find((entry) => entry.fileName === "b.ts")
		assert.strictEqual(b?.matches.length, 1)
	})
})
