import { describe, expect, it } from "vitest"
import {
	buildRipgrepArgs,
	createRipgrepParseState,
	parseRipgrepLine,
} from "../../search/ripgrepParser"
import type { SearchQuery } from "../../search/types"

function baseQuery(overrides: Partial<SearchQuery> = {}): SearchQuery {
	return {
		id: "q1",
		pattern: "needle",
		include: "",
		exclude: "",
		caseSensitive: false,
		wholeWord: false,
		useRegex: false,
		replace: "",
		...overrides,
	}
}

describe("buildRipgrepArgs", () => {
	it("uses fixed-string search by default", () => {
		const args = buildRipgrepArgs(baseQuery({ pattern: "foo.bar" }), "/root")
		expect(args).toContain("-F")
		expect(args).toContain("foo.bar")
		expect(args).toContain("--ignore-case")
		expect(args.at(-1)).toBe("/root")
	})

	it("uses regex mode when enabled", () => {
		const args = buildRipgrepArgs(
			baseQuery({ useRegex: true, pattern: "foo.*" }),
			"/root",
		)
		expect(args).toContain("-e")
		expect(args).toContain("foo.*")
		expect(args).not.toContain("-F")
	})

	it("adds case and whole-word flags", () => {
		const args = buildRipgrepArgs(
			baseQuery({ caseSensitive: true, wholeWord: true }),
			"/root",
		)
		expect(args).toContain("--case-sensitive")
		expect(args).toContain("--word-regexp")
	})

	it("adds include and exclude globs with normalization", () => {
		const args = buildRipgrepArgs(
			baseQuery({ include: "src/**", exclude: "*.log, dist/**" }),
			"/root",
		)
		expect(args).toContain("-g")
		expect(args).toEqual(
			expect.arrayContaining(["**/src/**", "!*.log", "!**/dist/**"]),
		)
	})
})

describe("parseRipgrepLine", () => {
	it("parses match and context events", () => {
		const state = createRipgrepParseState()

		parseRipgrepLine(
			JSON.stringify({
				type: "begin",
				data: { path: { text: "/proj/src/a.ts" } },
			}),
			state,
		)
		parseRipgrepLine(
			JSON.stringify({
				type: "context",
				data: {
					path: { text: "/proj/src/a.ts" },
					lines: { text: "before\n" },
					line_number: 1,
				},
			}),
			state,
		)
		parseRipgrepLine(
			JSON.stringify({
				type: "match",
				data: {
					path: { text: "/proj/src/a.ts" },
					lines: { text: "needle here\n" },
					line_number: 2,
					submatches: [{ start: 0, end: 6, match: { text: "needle" } }],
				},
			}),
			state,
		)
		parseRipgrepLine(JSON.stringify({ type: "end" }), state)

		expect(state.matches).toHaveLength(1)
		expect(state.matches[0].file).toBe("/proj/src/a.ts")
		expect(state.matches[0].line).toBe(2)
		expect(state.matches[0].matchStart).toBe(0)
		expect(state.matches[0].matchEnd).toBe(6)
		expect(state.matches[0].contextBefore).toHaveLength(1)
		expect(state.matches[0].contextBefore[0].text).toBe("before")
	})

	it("ignores invalid JSON lines", () => {
		const state = createRipgrepParseState()
		parseRipgrepLine("not json", state)
		expect(state.matches).toHaveLength(0)
	})

	it("resets state on begin and end", () => {
		const state = createRipgrepParseState()
		state.pendingBefore = [{ line: 1, text: "x" }]
		parseRipgrepLine(JSON.stringify({ type: "begin" }), state)
		expect(state.pendingBefore).toHaveLength(0)
	})
})
