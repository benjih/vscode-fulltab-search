// @ts-check
/// <reference lib="dom" />

// Edit mode: contenteditable line wiring with live re-tokenization and caret
// preservation. Editable lines keep their syntax-highlighted token spans in
// the DOM (a contenteditable element is happy to host a caret across child
// spans). As the user types we ask the extension to re-tokenize the new text
// (debounced) and re-render the spans, restoring the caret by character
// offset — so the line never degrades to plain text and editing feels like a
// real editor.

import { getSelectionOffsets, setCaretOffset } from "./caret.js"
import { vscode } from "./ipc.js"
import {
	getVisibleLineText,
	insertLineAfter,
	joinLineIntoPrevious,
	state,
	updateLineInDataModel,
} from "./model.js"
import {
	cancelScheduledLineTokens,
	requestLineTokens,
	scheduleLineTokens,
} from "./tokens.js"
import { resultsEl } from "./ui.js"

// Line splits/joins re-render the whole result list. The renderer is injected
// by the entry module so this module doesn't import render.js (which imports
// this module to wire editable lines).
let rerender = () => {}

/** @param {() => void} fn */
export function setRerender(fn) {
	rerender = fn
}

/**
 * Finds the rendered .line-content element for file:lineNumber, whether the
 * line is a match row or a context row.
 * @param {string} file
 * @param {number} lineNumber
 * @returns {HTMLElement | null}
 */
export function findLineContent(file, lineNumber) {
	const lineMatches = state.matchesByFileLine.get(`${file}:${lineNumber}`)
	for (const block of resultsEl.querySelectorAll(".match-block")) {
		if (/** @type {HTMLElement} */ (block).dataset.file !== file) continue
		const row =
			block.querySelector(`[data-context-line="${lineNumber}"]`) ??
			(lineMatches
				? block.querySelector(`[data-row-match-id="${lineMatches[0].id}"]`)
				: null)
		if (row) {
			return /** @type {HTMLElement | null} */ (
				row.querySelector(".line-content")
			)
		}
	}
	return null
}

// Commits any in-progress line edit (blur triggers the save-on-change path).
export function blurActiveEditableLine() {
	const active = /** @type {HTMLElement | null} */ (document.activeElement)
	if (
		active?.classList.contains("line-content") &&
		active.hasAttribute("contenteditable")
	) {
		active.blur()
	}
}

// Per-line commit functions, so Ctrl/Cmd+S can flush the focused line's
// pending edit without blurring it.
/** @type {WeakMap<HTMLElement, () => boolean>} */
const lineCommitters = new WeakMap()

export function flushActiveLineEdit() {
	const active = /** @type {HTMLElement | null} */ (document.activeElement)
	if (active) lineCommitters.get(active)?.()
}

/**
 * Splits an edited line at the caret (replacing any selection), Zed-style:
 * the extension replaces the document line with two lines, the local model
 * shifts subsequent line numbers, and focus moves to the start of the new line.
 * @param {HTMLElement} content
 * @param {{ baseline: string }} editState
 * @param {string} file
 * @param {number} lineNumber
 */
function handleLineSplit(content, editState, file, lineNumber) {
	cancelScheduledLineTokens(file, lineNumber)
	const text = content.textContent ?? ""
	const offsets = getSelectionOffsets(content) ?? {
		start: text.length,
		end: text.length,
	}
	const before = text.slice(0, Math.min(offsets.start, offsets.end))
	const after = text.slice(Math.max(offsets.start, offsets.end))
	// Neutralize the blur-commit — the split message carries the full edit.
	editState.baseline = text
	delete content.dataset.savedHtml
	vscode.postMessage({
		type: "splitLine",
		file,
		line: lineNumber,
		before,
		after,
	})
	updateLineInDataModel(file, lineNumber, before)
	insertLineAfter(file, lineNumber, after)
	rerender()
	const newContent = findLineContent(file, lineNumber + 1)
	if (newContent) {
		newContent.focus()
		setCaretOffset(newContent, 0)
		requestLineTokens(newContent, file, lineNumber + 1)
	}
	const beforeContent = findLineContent(file, lineNumber)
	if (beforeContent) requestLineTokens(beforeContent, file, lineNumber)
}

/**
 * Backspace at the start of a line: joins the line into the one above,
 * deleting the line break. Clamped at the edge of the visible excerpt — if
 * the previous line isn't part of the results, nothing happens. Returns
 * whether the join was performed.
 * @param {HTMLElement} content
 * @param {{ baseline: string }} editState
 * @param {string} file
 * @param {number} lineNumber
 */
function handleLineJoin(content, editState, file, lineNumber) {
	if (lineNumber < 2) return false
	const prevText = getVisibleLineText(file, lineNumber - 1)
	if (prevText === null) return false
	cancelScheduledLineTokens(file, lineNumber)
	cancelScheduledLineTokens(file, lineNumber - 1)
	const curText = content.textContent ?? ""
	const merged = prevText + curText
	// Neutralize the blur-commit — the join message carries the full edit.
	editState.baseline = curText
	delete content.dataset.savedHtml
	vscode.postMessage({
		type: "joinLines",
		file,
		line: lineNumber,
		mergedContent: merged,
	})
	joinLineIntoPrevious(file, lineNumber, merged, prevText.length)
	rerender()
	const mergedContent = findLineContent(file, lineNumber - 1)
	if (mergedContent) {
		mergedContent.focus()
		setCaretOffset(mergedContent, prevText.length)
		requestLineTokens(mergedContent, file, lineNumber - 1)
	}
	return true
}

/**
 * Makes a rendered line editable: commits on blur, splits on Enter, joins on
 * Backspace-at-start, restores on Escape, and re-tokenizes while typing.
 * @param {HTMLElement} content
 * @param {string} file
 * @param {number} lineNumber
 * @param {string} originalText
 */
export function wireEditableLine(content, file, lineNumber, originalText) {
	// `baseline` is the last text applied to the document for this line;
	// commits diff against it so flushing (Ctrl/Cmd+S) and blur never
	// double-apply the same edit.
	const editState = { baseline: originalText }
	// "plaintext-only" keeps the highlighted token spans in place while
	// making the line editable: the caret moves through the spans, typed
	// characters merge into the surrounding text nodes, and pasted
	// content is stripped to plain text.
	content.setAttribute("contenteditable", "plaintext-only")
	content.spellcheck = false

	// Applies the current text to the document buffer (not disk) if it
	// changed since the last commit. Returns whether an edit was sent.
	const commitLine = () => {
		const newText = content.textContent ?? ""
		if (newText === editState.baseline) return false
		editState.baseline = newText
		updateLineInDataModel(file, lineNumber, newText)
		vscode.postMessage({
			type: "editLine",
			file,
			line: lineNumber,
			newContent: newText,
		})
		// Re-tokenize the committed text so the rendered spans and the
		// result model regain accurate highlighting.
		requestLineTokens(content, file, lineNumber)
		return true
	}
	lineCommitters.set(content, commitLine)

	content.addEventListener("focus", () => {
		content.dataset.savedHtml = content.innerHTML
	})

	content.addEventListener("input", () => {
		scheduleLineTokens(content, file, lineNumber)
	})

	content.addEventListener("blur", () => {
		cancelScheduledLineTokens(file, lineNumber)
		const savedHtml = content.dataset.savedHtml
		delete content.dataset.savedHtml
		if (
			!commitLine() &&
			editState.baseline === originalText &&
			savedHtml !== undefined
		) {
			// Untouched this session: restore the original spans, incl.
			// match highlights.
			content.innerHTML = savedHtml
		}
	})

	content.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault()
			handleLineSplit(content, editState, file, lineNumber)
		} else if (e.key === "Escape") {
			e.preventDefault()
			const savedHtml = content.dataset.savedHtml
			if (savedHtml !== undefined && editState.baseline === originalText) {
				// Nothing committed this session: restore the original spans.
				content.innerHTML = savedHtml
			} else if ((content.textContent ?? "") !== editState.baseline) {
				// Something was already committed (e.g. via Ctrl/Cmd+S):
				// discard only the typing since that commit.
				content.textContent = editState.baseline
				requestLineTokens(content, file, lineNumber)
			}
			content.blur()
		} else if (e.key === "Backspace") {
			const offsets = getSelectionOffsets(content)
			// Only intercept a collapsed caret at the very start of the
			// line; everything else is normal in-line deletion.
			if (
				offsets &&
				offsets.start === 0 &&
				offsets.end === 0 &&
				handleLineJoin(content, editState, file, lineNumber)
			) {
				e.preventDefault()
			}
		} else if (e.key === "Tab") {
			e.preventDefault()
			document.execCommand("insertText", false, "\t")
		}
	})
}
