import assert from "node:assert"
import { describe, it } from "vitest"
import { createReplacementResolver, hasCaptureReference } from "./replacement"
import type { SearchState } from "./types"

function makeQuery(overrides: Partial<SearchState> = {}): SearchState {
	return {
		pattern: "",
		include: "",
		exclude: "",
		caseSensitive: false,
		wholeWord: false,
		useRegex: true,
		replace: "",
		...overrides,
	}
}

// Resolves the first occurrence of `pattern` in `line` the way the engine
// does: ripgrep supplies the offsets, the resolver re-derives the groups.
function resolveFirst(query: SearchState, line: string): string {
	const found = new RegExp(query.pattern, query.caseSensitive ? "" : "i").exec(
		line,
	)
	assert.ok(found, "test line must contain the pattern")
	return createReplacementResolver(query)(
		line,
		found.index,
		found.index + found[0].length,
	)
}

describe("hasCaptureReference", () => {
	it("detects the reference forms VS Code expands", () => {
		assert.strictEqual(hasCaptureReference("$1"), true)
		assert.strictEqual(hasCaptureReference("pre $12 post"), true)
		assert.strictEqual(hasCaptureReference("$&"), true)
		assert.strictEqual(hasCaptureReference("$$"), true)
		assert.strictEqual(hasCaptureReference("$<name>"), true)
	})

	it("ignores a plain dollar sign", () => {
		assert.strictEqual(hasCaptureReference("cost: $ 5"), false)
		assert.strictEqual(hasCaptureReference("total$"), false)
		assert.strictEqual(hasCaptureReference("$name"), false)
	})
})

describe("createReplacementResolver", () => {
	it("returns the replacement literally when regex mode is off", () => {
		const query = makeQuery({
			pattern: "foo_bar",
			useRegex: false,
			replace: "$1",
		})
		assert.strictEqual(
			createReplacementResolver(query)("x foo_bar y", 2, 9),
			"$1",
		)
	})

	it("expands numbered groups", () => {
		const query = makeQuery({
			pattern: "(\\w+)_(\\w+)",
			replace: "$2_$1",
		})
		assert.strictEqual(resolveFirst(query, "const foo_bar = 1"), "bar_foo")
	})

	it("expands $& and $0 to the whole match and $$ to a literal dollar", () => {
		const query = makeQuery({ pattern: "foo\\w*", replace: "$$[$&|$0]" })
		assert.strictEqual(resolveFirst(query, "a foobar b"), "$[foobar|foobar]")
	})

	it("expands named groups", () => {
		const query = makeQuery({
			pattern: "(?<head>\\w+)_tail",
			replace: "$<head>_head",
		})
		assert.strictEqual(resolveFirst(query, "x foo_tail y"), "foo_head")
	})

	it("expands a group that did not participate to nothing", () => {
		const query = makeQuery({ pattern: "foo(bar)?", replace: "[$1]" })
		assert.strictEqual(resolveFirst(query, "a foo b"), "[]")
	})

	it("falls back to a single-digit group when no two-digit group exists", () => {
		const query = makeQuery({ pattern: "(\\w+)_tail", replace: "$12" })
		assert.strictEqual(resolveFirst(query, "foo_tail"), "foo2")
	})

	it("leaves a reference to a group the pattern does not declare alone", () => {
		const query = makeQuery({ pattern: "foo", replace: "$3" })
		assert.strictEqual(resolveFirst(query, "foo"), "$3")
	})

	it("honours case sensitivity when re-running the pattern", () => {
		const query = makeQuery({
			pattern: "(foo)_bar",
			caseSensitive: false,
			replace: "$1",
		})
		assert.strictEqual(resolveFirst(query, "FOO_bar"), "FOO")
	})

	it("matches the whole-word span ripgrep reports", () => {
		// Without the -w wrapper the JS re-run would settle on "foo" and its
		// span would disagree with the "foobar" ripgrep replaces.
		const query = makeQuery({
			pattern: "(foo|foobar)",
			wholeWord: true,
			replace: "<$1>",
		})
		assert.strictEqual(
			createReplacementResolver(query)("a foobar b", 2, 8),
			"<foobar>",
		)
	})

	it("throws up front for a pattern JavaScript cannot compile", () => {
		const query = makeQuery({ pattern: "(?P<name>foo)", replace: "$1" })
		assert.throws(
			() => createReplacementResolver(query),
			/not a valid JavaScript regular expression/,
		)
	})

	it("throws when the re-run lands on a different span", () => {
		const query = makeQuery({ pattern: "(foo)", replace: "$1" })
		assert.throws(
			() => createReplacementResolver(query)("a foo b", 2, 4),
			/differently in JavaScript/,
		)
	})

	it("does not compile the pattern when the replacement has no references", () => {
		// An engine-only pattern is fine as long as nothing needs its groups.
		const query = makeQuery({ pattern: "(?P<name>foo)", replace: "bar" })
		assert.strictEqual(createReplacementResolver(query)("foo", 0, 3), "bar")
	})
})
