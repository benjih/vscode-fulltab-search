// @vitest-environment jsdom

// Tests for the edit-mode behavior of the webview script (media/search.js).
//
// The script is a plain browser script, not a module — it is executed here
// inside a jsdom document built from the same element ids the panel HTML
// provides, with acquireVsCodeApi stubbed to capture outgoing messages.
// Tests drive it the way VS Code does: posting `message` events in and
// asserting on the rendered DOM and the messages posted out.

import * as fs from "node:fs"
import * as path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const webviewSource = fs.readFileSync(
	path.resolve(process.cwd(), "media", "search.js"),
	"utf8",
)

// Mirrors the element ids rendered by SearchPanel.getHtml().
const PANEL_SKELETON = `
	<input id="patternInput" />
	<input id="includeInput" />
	<input id="excludeInput" />
	<input id="replaceInput" />
	<button id="caseToggle"></button>
	<button id="wordToggle"></button>
	<button id="regexToggle"></button>
	<button id="prevMatch"></button>
	<span id="matchCounter"></span>
	<button id="nextMatch"></button>
	<button id="editToggle"></button>
	<button id="replaceOne"></button>
	<button id="replaceAll"></button>
	<div id="statusBar"></div>
	<div id="results"></div>
`

type PostedMessage = { type: string } & Record<string, unknown>

const FILE = "/ws/src/sample.ts"

function makeResults() {
	const common = { file: FILE, relativePath: "src/sample.ts", breadcrumb: "" }
	return {
		queryId: "q1",
		total: 2,
		truncated: false,
		fileResults: [
			{
				file: FILE,
				relativePath: "src/sample.ts",
				directory: "src",
				fileName: "sample.ts",
				matches: [
					{
						...common,
						id: 0,
						line: 5,
						column: 6,
						lineText: "const marker = alpha",
						matchStart: 6,
						matchEnd: 12,
						contextBefore: [
							{ line: 3, text: "// three" },
							{ line: 4, text: "// four" },
						],
						contextAfter: [
							{ line: 6, text: "// six" },
							{ line: 7, text: "// seven" },
						],
					},
					{
						...common,
						id: 1,
						line: 20,
						column: 0,
						lineText: "marker again",
						matchStart: 0,
						matchEnd: 6,
						contextBefore: [
							{ line: 18, text: "// eighteen" },
							{ line: 19, text: "// nineteen" },
						],
						contextAfter: [{ line: 21, text: "// twenty-one" }],
					},
				],
			},
		],
	}
}

function boot(): PostedMessage[] {
	document.body.innerHTML = PANEL_SKELETON
	const posted: PostedMessage[] = []
	const globals = globalThis as Record<string, unknown>
	globals.acquireVsCodeApi = () => ({
		postMessage: (message: unknown) => posted.push(message as PostedMessage),
	})
	globals.IntersectionObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	;(document as unknown as Record<string, unknown>).execCommand = vi.fn()
	new Function(webviewSource)()
	posted.length = 0 // discard the initial "ready" handshake
	return posted
}

function deliver(data: unknown) {
	window.dispatchEvent(new MessageEvent("message", { data }))
}

function elementById(id: string): HTMLElement {
	const el = document.getElementById(id)
	if (!el) throw new Error(`missing #${id}`)
	return el
}

function rowContent(selector: string): HTMLElement {
	const row = document.querySelector(selector)
	const content = row?.querySelector(".line-content")
	if (!content) throw new Error(`no .line-content for ${selector}`)
	return content as HTMLElement
}

function rowLineNumber(selector: string): string {
	const row = document.querySelector(selector)
	const lineNumber = row?.querySelector(".line-number")
	if (!lineNumber) throw new Error(`no .line-number for ${selector}`)
	return lineNumber.textContent ?? ""
}

function contextRow(line: number): HTMLElement {
	return rowContent(`[data-context-line="${line}"]`)
}

function matchRow(id: number): HTMLElement {
	return rowContent(`[data-row-match-id="${id}"]`)
}

function enterEditMode() {
	elementById("editToggle").click()
}

function placeCaret(el: HTMLElement, offset: number) {
	const range = document.createRange()
	if (offset === 0) {
		range.setStart(el, 0)
	} else {
		const node = el.firstChild
		if (!node) throw new Error("no child node to place caret in")
		range.setStart(node, offset)
	}
	range.collapse(true)
	const selection = window.getSelection()
	if (!selection) throw new Error("no selection available")
	selection.removeAllRanges()
	selection.addRange(range)
}

function pressKey(el: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
	const event = new KeyboardEvent("keydown", {
		cancelable: true,
		bubbles: true,
		...init,
	})
	el.dispatchEvent(event)
	return event
}

function blur(el: HTMLElement) {
	el.dispatchEvent(new FocusEvent("blur"))
}

function ofType(posted: PostedMessage[], type: string): PostedMessage[] {
	return posted.filter((message) => message.type === type)
}

let posted: PostedMessage[]

beforeEach(() => {
	window.getSelection()?.removeAllRanges()
	posted = boot()
	deliver({ type: "results", results: makeResults() })
})

describe("results rendering", () => {
	it("renders match and context rows with line numbers", () => {
		expect(matchRow(0).textContent).toBe("const marker = alpha")
		expect(contextRow(3).textContent).toBe("// three")
		expect(rowLineNumber('[data-row-match-id="1"]')).toBe("20")
		expect(elementById("matchCounter").textContent).toBe("1/2")
	})
})

describe("edit mode", () => {
	it("makes lines editable without losing syntax/match spans", () => {
		enterEditMode()
		for (const content of document.querySelectorAll(".line-content")) {
			expect(content.getAttribute("contenteditable")).toBe("plaintext-only")
		}
		// The original complaint: entering edit mode must not flatten the
		// rendered spans to plain text.
		expect(matchRow(0).querySelector(".match-highlight")).not.toBeNull()
	})

	it("commits a changed line on blur and keeps it across re-renders", () => {
		enterEditMode()
		const content = contextRow(6)
		content.textContent = "// SIX edited"
		blur(content)

		expect(ofType(posted, "editLine")).toEqual([
			{ type: "editLine", file: FILE, line: 6, newContent: "// SIX edited" },
		])
		// The committed text is re-tokenized so highlighting comes back.
		expect(ofType(posted, "tokenizeLine").at(-1)).toMatchObject({
			line: 6,
			text: "// SIX edited",
		})

		// Survives a full re-render (model was updated, not just the DOM).
		elementById("editToggle").click()
		expect(contextRow(6).textContent).toBe("// SIX edited")
	})

	it("posts nothing when blurring an untouched line", () => {
		enterEditMode()
		const content = matchRow(0)
		content.tabIndex = 0
		content.focus()
		blur(content)

		expect(ofType(posted, "editLine")).toHaveLength(0)
		expect(content.querySelector(".match-highlight")).not.toBeNull()
	})

	it("Escape discards typing and restores the original line", () => {
		enterEditMode()
		const content = contextRow(6)
		content.tabIndex = 0
		content.focus()
		content.textContent = "garbage"
		pressKey(content, { key: "Escape" })

		expect(content.textContent).toBe("// six")
		expect(ofType(posted, "editLine")).toHaveLength(0)
	})

	it("Tab inserts a tab character instead of moving focus", () => {
		enterEditMode()
		const event = pressKey(contextRow(6), { key: "Tab" })

		expect(event.defaultPrevented).toBe(true)
		expect(
			(document as unknown as { execCommand: ReturnType<typeof vi.fn> })
				.execCommand,
		).toHaveBeenCalledWith("insertText", false, "\t")
	})

	it("requests re-tokenization while typing (debounced)", () => {
		enterEditMode()
		const content = contextRow(6)
		vi.useFakeTimers()
		try {
			content.textContent = "// si"
			content.dispatchEvent(new Event("input"))
			expect(ofType(posted, "tokenizeLine")).toHaveLength(0)
			vi.advanceTimersByTime(150)
			expect(ofType(posted, "tokenizeLine")).toEqual([
				{ type: "tokenizeLine", file: FILE, line: 6, text: "// si" },
			])
		} finally {
			vi.useRealTimers()
		}
	})
})

describe("Enter splits the line", () => {
	it("splits at the caret and shifts following lines down", () => {
		enterEditMode()
		const content = contextRow(6)
		placeCaret(content, 3)
		const event = pressKey(content, { key: "Enter" })

		expect(event.defaultPrevented).toBe(true)
		expect(ofType(posted, "splitLine")).toEqual([
			{ type: "splitLine", file: FILE, line: 6, before: "// ", after: "six" },
		])
		expect(contextRow(6).textContent).toBe("// ")
		expect(contextRow(7).textContent).toBe("six")
		expect(contextRow(8).textContent).toBe("// seven")
		// Lines in later sections shift too.
		expect(rowLineNumber('[data-row-match-id="1"]')).toBe("21")
	})

	it("splits at the end of the line when the caret is elsewhere", () => {
		enterEditMode()
		window.getSelection()?.removeAllRanges()
		pressKey(contextRow(6), { key: "Enter" })

		expect(ofType(posted, "splitLine")).toEqual([
			{ type: "splitLine", file: FILE, line: 6, before: "// six", after: "" },
		])
	})
})

describe("Backspace joins lines", () => {
	it("joins a context line into the previous line", () => {
		enterEditMode()
		const content = contextRow(4)
		placeCaret(content, 0)
		const event = pressKey(content, { key: "Backspace" })

		expect(event.defaultPrevented).toBe(true)
		expect(ofType(posted, "joinLines")).toEqual([
			{
				type: "joinLines",
				file: FILE,
				line: 4,
				mergedContent: "// three// four",
			},
		])
		expect(contextRow(3).textContent).toBe("// three// four")
		// Everything below shifts up by one.
		expect(rowLineNumber('[data-row-match-id="0"]')).toBe("4")
		expect(rowLineNumber('[data-row-match-id="1"]')).toBe("19")
	})

	it("moves a match line up and shifts its highlight offsets", () => {
		enterEditMode()
		const content = matchRow(0)
		placeCaret(content, 0)
		pressKey(content, { key: "Backspace" })

		expect(ofType(posted, "joinLines")).toEqual([
			{
				type: "joinLines",
				file: FILE,
				line: 5,
				mergedContent: "// fourconst marker = alpha",
			},
		])
		expect(rowLineNumber('[data-row-match-id="0"]')).toBe("4")
		// The highlight still wraps "marker" — offsets moved by the length of
		// the absorbed previous line.
		const highlight = matchRow(0).querySelector(".match-highlight")
		expect(highlight?.textContent).toBe("marker")
	})

	it("does nothing at the top edge of an excerpt", () => {
		enterEditMode()
		const content = contextRow(3)
		placeCaret(content, 0)
		const event = pressKey(content, { key: "Backspace" })

		expect(ofType(posted, "joinLines")).toHaveLength(0)
		expect(event.defaultPrevented).toBe(false)
	})

	it("leaves mid-line deletion to the browser", () => {
		enterEditMode()
		const content = contextRow(4)
		placeCaret(content, 3)
		const event = pressKey(content, { key: "Backspace" })

		expect(ofType(posted, "joinLines")).toHaveLength(0)
		expect(event.defaultPrevented).toBe(false)
	})
})

describe("saving", () => {
	it("Ctrl/Cmd+S flushes the focused line's typing, then saves", () => {
		enterEditMode()
		const content = contextRow(6)
		content.tabIndex = 0
		content.focus()
		content.textContent = "// changed"
		pressKey(content, { key: "s", metaKey: true })

		const editIndex = posted.findIndex((m) => m.type === "editLine")
		const saveIndex = posted.findIndex((m) => m.type === "saveEdits")
		expect(posted[editIndex]).toMatchObject({
			line: 6,
			newContent: "// changed",
		})
		expect(saveIndex).toBeGreaterThan(editIndex)
	})

	it("shows unsaved/saved status messages", () => {
		deliver({ type: "lineEdited", file: FILE, line: 6, newContent: "x" })
		expect(elementById("statusBar").textContent).toBe(
			"Unsaved changes — press Ctrl/Cmd+S to save",
		)

		deliver({ type: "editsSaved", count: 2 })
		expect(elementById("statusBar").textContent).toBe("Saved 2 files")

		deliver({ type: "editsSaved", count: 0 })
		expect(elementById("statusBar").textContent).toBe("No unsaved changes")
	})
})

describe("live tokenization", () => {
	const tokens = [
		{ text: "//", color: "#008000" },
		{ text: " three", color: null },
	]

	it("applies token spans for the current text", () => {
		deliver({
			type: "lineTokens",
			file: FILE,
			line: 3,
			text: "// three",
			tokens,
		})

		expect(contextRow(3).innerHTML).toContain(
			'<span style="color:#008000">//</span>',
		)
	})

	it("ignores stale responses for text that changed again", () => {
		deliver({
			type: "lineTokens",
			file: FILE,
			line: 3,
			text: "different",
			tokens: [{ text: "different", color: "#ff0000" }],
		})

		expect(contextRow(3).innerHTML).not.toContain("#ff0000")
		expect(contextRow(3).textContent).toBe("// three")
	})

	it("keeps stored tokens across re-renders", () => {
		deliver({
			type: "lineTokens",
			file: FILE,
			line: 3,
			text: "// three",
			tokens,
		})
		enterEditMode()

		expect(contextRow(3).innerHTML).toContain(
			'<span style="color:#008000">//</span>',
		)
	})
})
