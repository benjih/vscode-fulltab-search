import * as path from "node:path"
import { describe, expect, it } from "vitest"
import {
	buildBreadcrumb,
	extractSymbol,
	groupByFile,
	splitPatterns,
} from "../../search/searchUtils"
import type { SearchMatch } from "../../search/types"

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

describe("buildBreadcrumb", () => {
	it("joins symbols above the match line", () => {
		const lines = ["export function outer() {", "  return fulltab_marker;"]
		expect(buildBreadcrumb(lines, 2)).toBe("outer")
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
