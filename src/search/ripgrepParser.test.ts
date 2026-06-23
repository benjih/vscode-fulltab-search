import assert from "node:assert"
import {
	buildRipgrepArgs,
	createRipgrepParseState,
	parseRipgrepLine,
} from "./ripgrepParser"
import type { SearchQuery } from "./types"

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
		assert.ok(args.includes("-F"))
		assert.ok(args.includes("foo.bar"))
		assert.ok(args.includes("--ignore-case"))
		assert.strictEqual(args.at(-1), "/root")
	})

	it("uses regex mode when enabled", () => {
		const args = buildRipgrepArgs(
			baseQuery({ useRegex: true, pattern: "foo.*" }),
			"/root",
		)
		assert.ok(args.includes("-e"))
		assert.ok(args.includes("foo.*"))
		assert.ok(!args.includes("-F"))
	})

	it("adds case and whole-word flags", () => {
		const args = buildRipgrepArgs(
			baseQuery({ caseSensitive: true, wholeWord: true }),
			"/root",
		)
		assert.ok(args.includes("--case-sensitive"))
		assert.ok(args.includes("--word-regexp"))
	})

	it("includes hidden files and directories", () => {
		const args = buildRipgrepArgs(baseQuery(), "/root")
		assert.ok(args.includes("--hidden"))
	})

	it("adds include and exclude globs with normalization", () => {
		const args = buildRipgrepArgs(
			baseQuery({ include: "src/**", exclude: "*.log, dist/**" }),
			"/root",
		)
		assert.ok(args.includes("-g"))
		assert.ok(["**/src/**", "!*.log", "!**/dist/**"].every((x) => args.includes(x)))
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

		assert.strictEqual(state.matches.length, 1)
		assert.strictEqual(state.matches[0].file, "/proj/src/a.ts")
		assert.strictEqual(state.matches[0].line, 2)
		assert.strictEqual(state.matches[0].matchStart, 0)
		assert.strictEqual(state.matches[0].matchEnd, 6)
		assert.strictEqual(state.matches[0].contextBefore.length, 1)
		assert.strictEqual(state.matches[0].contextBefore[0].text, "before")
	})

	it("emits one match per submatch when a line has multiple occurrences", () => {
		const state = createRipgrepParseState()

		parseRipgrepLine(
			JSON.stringify({
				type: "match",
				data: {
					path: { text: "/proj/src/a.ts" },
					lines: { text: "needle and needle\n" },
					line_number: 5,
					submatches: [
						{ start: 0, end: 6, match: { text: "needle" } },
						{ start: 11, end: 17, match: { text: "needle" } },
					],
				},
			}),
			state,
		)

		assert.strictEqual(state.matches.length, 2)
		assert.strictEqual(state.matches[0].matchStart, 0)
		assert.strictEqual(state.matches[0].matchEnd, 6)
		assert.strictEqual(state.matches[1].matchStart, 11)
		assert.strictEqual(state.matches[1].matchEnd, 17)
		assert.strictEqual(state.matches[1].line, 5)
	})

	it("ignores invalid JSON lines", () => {
		const state = createRipgrepParseState()
		parseRipgrepLine("not json", state)
		assert.strictEqual(state.matches.length, 0)
	})

	it("resets state on begin and end", () => {
		const state = createRipgrepParseState()
		state.pendingBefore = [{ line: 1, text: "x" }]
		parseRipgrepLine(JSON.stringify({ type: "begin" }), state)
		assert.strictEqual(state.pendingBefore.length, 0)
	})
})
