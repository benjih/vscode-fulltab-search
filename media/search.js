// @ts-check
/// <reference lib="dom" />

// Webview UI script for the FullTab Search panel.
//
// VS Code extension webviews run in a sandboxed browser context — no Node.js,
// no direct VS Code API access, and no access to the extension host's memory.
// This file lives in media/ so the extension can load it as a static asset via
// a webview panel URI. All communication with the extension host (searching,
// opening files, replacing text) goes through the postMessage / onDidReceiveMessage
// IPC bridge that VS Code provides for webviews.

/** @typedef {{ pattern: string; include: string; exclude: string; caseSensitive: boolean; wholeWord: boolean; useRegex: boolean; replace: string }} SearchState */
/** @typedef {{ text: string; color: string | null }} TokenSpan */
/** @typedef {{ line: number; text: string; tokens?: TokenSpan[] }} ContextLine */
/** @typedef {{ id: number; file: string; relativePath: string; line: number; column: number; lineText: string; matchStart: number; matchEnd: number; contextBefore: ContextLine[]; contextAfter: ContextLine[]; breadcrumb: string; tokens?: TokenSpan[] }} SearchMatch */
/** @typedef {{ file: string; relativePath: string; directory: string; fileName: string; matches: SearchMatch[] }} FileResult */
/** @typedef {{ queryId: string; fileResults: FileResult[]; total: number; truncated: boolean }} SearchResults */

// acquireVsCodeApi() is injected by the webview runtime and must be called exactly once.
/** @type {import('vscode') | undefined} */
const vscode = acquireVsCodeApi()

// Mutable UI state — all mutations go through the sync helpers below.
/** @type {SearchState} */
let searchState = {
	pattern: "",
	include: "",
	exclude: "",
	caseSensitive: false,
	wholeWord: false,
	useRegex: false,
	replace: "",
}
/** @type {SearchResults | null} */
let currentResults = null
/** @type {Map<number, SearchMatch>} */
let matchById = new Map()
/** @type {Map<string, SearchMatch[]>} keyed by "file:lineNumber" — all matches on that line */
let matchesByFileLine = new Map()
/** @type {number} */
let activeMatchIndex = 0
/** @type {boolean} */
let editMode = false

// Number of lines to reveal each time the user clicks an expand-context button.
const EXPAND_STEP = 10

/** @typedef {{ contextBefore: ContextLine[]; contextAfter: ContextLine[]; canExpandBefore: boolean; canExpandAfter: boolean }} ExpandedSection */

// Keyed by match ID. Tracks context lines that have been expanded beyond what
// the initial search result included, so re-renders don't lose that state.
/** @type {Map<number, ExpandedSection>} */
const expandedSections = new Map()

/** @type {Map<string, TokenSpan[]>} keyed by "file:lineNumber" */
const contextTokenCache = new Map()
/** @type {Set<number>} first-match IDs of sections that have already been requested */
const contextTokenRequested = new Set()
/** @type {WeakMap<Element, { file: string; lines: Array<{line: number; text: string}>; firstMatchId: number }>} */
const blockContextMeta = new WeakMap()

const contextObserver = new IntersectionObserver(
	(entries) => {
		for (const entry of entries) {
			if (!entry.isIntersecting) continue
			const meta = blockContextMeta.get(entry.target)
			if (!meta || contextTokenRequested.has(meta.firstMatchId)) continue
			contextTokenRequested.add(meta.firstMatchId)
			vscode.postMessage({
				type: "tokenizeContext",
				matchId: meta.firstMatchId,
				file: meta.file,
				lines: meta.lines,
			})
		}
	},
	{ rootMargin: "200px" },
)

// ---- Edit mode: live re-tokenization with caret preservation ----
// Editable lines keep their syntax-highlighted token spans in the DOM (a
// contenteditable element is happy to host a caret across child spans). As
// the user types we ask the extension to re-tokenize the new text (debounced)
// and re-render the spans, restoring the caret by character offset — so the
// line never degrades to plain text and editing feels like a real editor.

const LIVE_TOKENIZE_DEBOUNCE_MS = 120

/** @type {Map<string, ReturnType<typeof setTimeout>>} keyed by "file:lineNumber" */
const liveTokenizeTimers = new Map()

/**
 * @param {HTMLElement} content
 * @param {string} file
 * @param {number} lineNumber
 */
function requestLineTokens(content, file, lineNumber) {
	vscode.postMessage({
		type: "tokenizeLine",
		file,
		line: lineNumber,
		text: content.textContent ?? "",
	})
}

/**
 * @param {HTMLElement} content
 * @param {string} file
 * @param {number} lineNumber
 */
function scheduleLineTokens(content, file, lineNumber) {
	const key = `${file}:${lineNumber}`
	const pending = liveTokenizeTimers.get(key)
	if (pending !== undefined) clearTimeout(pending)
	liveTokenizeTimers.set(
		key,
		setTimeout(() => {
			liveTokenizeTimers.delete(key)
			requestLineTokens(content, file, lineNumber)
		}, LIVE_TOKENIZE_DEBOUNCE_MS),
	)
}

/** @param {string} file @param {number} lineNumber */
function cancelScheduledLineTokens(file, lineNumber) {
	const key = `${file}:${lineNumber}`
	const pending = liveTokenizeTimers.get(key)
	if (pending !== undefined) {
		clearTimeout(pending)
		liveTokenizeTimers.delete(key)
	}
}

/**
 * Character offset of (node, nodeOffset) within `el`.
 * @param {HTMLElement} el
 * @param {Node} node
 * @param {number} nodeOffset
 */
function caretOffsetAt(el, node, nodeOffset) {
	const measure = document.createRange()
	measure.selectNodeContents(el)
	measure.setEnd(node, nodeOffset)
	return measure.toString().length
}

/**
 * Character offset of the caret within `el`, or null if the caret is elsewhere.
 * @param {HTMLElement} el
 */
function getCaretOffset(el) {
	const selection = window.getSelection()
	if (!selection || selection.rangeCount === 0) return null
	const range = selection.getRangeAt(0)
	if (!el.contains(range.endContainer)) return null
	return caretOffsetAt(el, range.endContainer, range.endOffset)
}

/**
 * Start/end character offsets of the current selection within `el`,
 * or null if the selection is elsewhere.
 * @param {HTMLElement} el
 * @returns {{ start: number; end: number } | null}
 */
function getSelectionOffsets(el) {
	const selection = window.getSelection()
	if (!selection || selection.rangeCount === 0) return null
	const range = selection.getRangeAt(0)
	if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) {
		return null
	}
	return {
		start: caretOffsetAt(el, range.startContainer, range.startOffset),
		end: caretOffsetAt(el, range.endContainer, range.endOffset),
	}
}

/**
 * Places a collapsed caret at character offset `offset` within `el`.
 * @param {HTMLElement} el
 * @param {number} offset
 */
function setCaretOffset(el, offset) {
	const selection = window.getSelection()
	if (!selection) return
	const range = document.createRange()
	let remaining = offset
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
	let node = walker.nextNode()
	while (node) {
		const length = node.textContent?.length ?? 0
		if (remaining <= length) {
			range.setStart(node, remaining)
			range.collapse(true)
			selection.removeAllRanges()
			selection.addRange(range)
			return
		}
		remaining -= length
		node = walker.nextNode()
	}
	range.selectNodeContents(el)
	range.collapse(false)
	selection.removeAllRanges()
	selection.addRange(range)
}

/**
 * Finds the rendered .line-content element for file:lineNumber, whether the
 * line is a match row or a context row.
 * @param {string} file
 * @param {number} lineNumber
 * @returns {HTMLElement | null}
 */
function findLineContent(file, lineNumber) {
	const lineMatches = matchesByFileLine.get(`${file}:${lineNumber}`)
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
function blurActiveEditableLine() {
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

function flushActiveLineEdit() {
	const active = /** @type {HTMLElement | null} */ (document.activeElement)
	if (active) lineCommitters.get(active)?.()
}

// Rebuilds matchById / matchesByFileLine, e.g. after line numbers shift.
function rebuildMatchIndexes() {
	const allMatches = currentResults
		? currentResults.fileResults.flatMap((f) => f.matches)
		: []
	matchById = new Map(allMatches.map((m) => [m.id, m]))
	matchesByFileLine = new Map()
	for (const m of allMatches) {
		const key = `${m.file}:${m.line}`
		const existing = matchesByFileLine.get(key)
		if (existing) {
			existing.push(m)
		} else {
			matchesByFileLine.set(key, [m])
		}
	}
}

/**
 * Shifts cached context tokens for `file` below `fromLine` by `delta` lines.
 * @param {string} file
 * @param {number} fromLine
 * @param {number} delta
 */
function shiftContextTokenCache(file, fromLine, delta) {
	/** @type {Array<[number, TokenSpan[]]>} */
	const moved = []
	for (const [key, tokens] of contextTokenCache) {
		const sep = key.lastIndexOf(":")
		if (key.slice(0, sep) !== file) continue
		const line = Number(key.slice(sep + 1))
		if (line > fromLine) {
			moved.push([line, tokens])
			contextTokenCache.delete(key)
		}
	}
	for (const [line, tokens] of moved) {
		contextTokenCache.set(`${file}:${line + delta}`, tokens)
	}
}

/**
 * Text of `file`:`lineNumber` if that line is part of the rendered results
 * (as a match line or context line), else null.
 * @param {string} file
 * @param {number} lineNumber
 * @returns {string | null}
 */
function getVisibleLineText(file, lineNumber) {
	const lineMatches = matchesByFileLine.get(`${file}:${lineNumber}`)
	if (lineMatches && lineMatches.length > 0) return lineMatches[0].lineText
	if (!currentResults) return null
	for (const fileResult of currentResults.fileResults) {
		if (fileResult.file !== file) continue
		for (const match of fileResult.matches) {
			const expanded = expandedSections.get(match.id)
			const contextArrays = [match.contextBefore, match.contextAfter]
			if (expanded) {
				contextArrays.push(expanded.contextBefore, expanded.contextAfter)
			}
			for (const arr of contextArrays) {
				const ctx = arr.find((c) => c.line === lineNumber)
				if (ctx) return ctx.text
			}
		}
	}
	return null
}

/**
 * Removes `lineNumber` from the local result model, merging its text into the
 * line above (`merged` = previous text + current text) and shifting all
 * subsequent line numbers in `file` up by one — mirroring the line break the
 * extension deletes from the document.
 * @param {string} file
 * @param {number} lineNumber
 * @param {string} merged
 * @param {number} prevLength length of the previous line's text before the join
 */
function joinLineIntoPrevious(file, lineNumber, merged, prevLength) {
	if (!currentResults) return
	contextTokenCache.delete(`${file}:${lineNumber - 1}`)
	contextTokenCache.delete(`${file}:${lineNumber}`)
	shiftContextTokenCache(file, lineNumber, -1)

	/** @param {ContextLine[]} arr */
	const transformContextArray = (arr) => {
		for (let i = arr.length - 1; i >= 0; i--) {
			const ctx = arr[i]
			if (ctx.line === lineNumber) {
				arr.splice(i, 1)
			} else if (ctx.line === lineNumber - 1) {
				ctx.text = merged
				ctx.tokens = undefined
			} else if (ctx.line > lineNumber) {
				ctx.line -= 1
			}
		}
	}

	for (const fileResult of currentResults.fileResults) {
		if (fileResult.file !== file) continue
		for (const match of fileResult.matches) {
			const expanded = expandedSections.get(match.id)
			const contextArrays = [match.contextBefore, match.contextAfter]
			if (expanded) {
				contextArrays.push(expanded.contextBefore, expanded.contextAfter)
			}
			if (match.line === lineNumber) {
				// The match's line was absorbed into the one above it.
				match.line = lineNumber - 1
				match.lineText = merged
				match.matchStart += prevLength
				match.matchEnd += prevLength
				match.column += prevLength
				match.tokens = undefined
			} else if (match.line === lineNumber - 1) {
				match.lineText = merged
				match.tokens = undefined
			} else if (match.line > lineNumber) {
				match.line -= 1
			}
			for (const arr of contextArrays) {
				transformContextArray(arr)
			}
		}
	}
	rebuildMatchIndexes()
}

/**
 * Inserts a new line with `text` immediately after `lineNumber` in the local
 * result model, shifting all subsequent line numbers in `file` down by one —
 * mirroring the line break the extension inserts into the document.
 * @param {string} file
 * @param {number} lineNumber
 * @param {string} text
 */
function insertLineAfter(file, lineNumber, text) {
	if (!currentResults) return
	shiftContextTokenCache(file, lineNumber, 1)
	for (const fileResult of currentResults.fileResults) {
		if (fileResult.file !== file) continue
		for (const match of fileResult.matches) {
			const expanded = expandedSections.get(match.id)
			const contextArrays = [match.contextBefore, match.contextAfter]
			if (expanded) {
				contextArrays.push(expanded.contextBefore, expanded.contextAfter)
			}
			if (match.line > lineNumber) match.line += 1
			for (const arr of contextArrays) {
				for (const ctx of arr) {
					if (ctx.line > lineNumber) ctx.line += 1
				}
			}
			// The new line becomes a context line directly below the split line,
			// in every copy of the context that contains it.
			if (match.line === lineNumber) {
				match.contextAfter.unshift({ line: lineNumber + 1, text })
				if (expanded) {
					expanded.contextAfter.unshift({ line: lineNumber + 1, text })
				}
			}
			for (const arr of contextArrays) {
				const idx = arr.findIndex((ctx) => ctx.line === lineNumber)
				if (idx !== -1) arr.splice(idx + 1, 0, { line: lineNumber + 1, text })
			}
		}
	}
	rebuildMatchIndexes()
}

/**
 * Stores freshly tokenized spans back into the result model and context cache
 * so later re-renders keep the highlighting. Guarded by text equality so a
 * stale response never attaches to newer content.
 * @param {string} file
 * @param {number} lineNumber
 * @param {string} text
 * @param {TokenSpan[]} tokens
 */
function storeLineTokens(file, lineNumber, text, tokens) {
	contextTokenCache.set(`${file}:${lineNumber}`, tokens)
	if (!currentResults) return
	for (const fileResult of currentResults.fileResults) {
		if (fileResult.file !== file) continue
		for (const match of fileResult.matches) {
			if (match.line === lineNumber && match.lineText === text) {
				match.tokens = tokens
			}
			for (const ctx of [...match.contextBefore, ...match.contextAfter]) {
				if (ctx.line === lineNumber && ctx.text === text) {
					ctx.tokens = tokens
				}
			}
		}
	}
	for (const [matchId, expanded] of expandedSections) {
		if (matchById.get(matchId)?.file !== file) continue
		for (const ctx of [...expanded.contextBefore, ...expanded.contextAfter]) {
			if (ctx.line === lineNumber && ctx.text === text) {
				ctx.tokens = tokens
			}
		}
	}
}

const patternInput = /** @type {HTMLInputElement} */ (
	document.getElementById("patternInput")
)
const includeInput = /** @type {HTMLInputElement} */ (
	document.getElementById("includeInput")
)
const excludeInput = /** @type {HTMLInputElement} */ (
	document.getElementById("excludeInput")
)
const replaceInput = /** @type {HTMLInputElement} */ (
	document.getElementById("replaceInput")
)
const caseToggle = /** @type {HTMLButtonElement} */ (
	document.getElementById("caseToggle")
)
const wordToggle = /** @type {HTMLButtonElement} */ (
	document.getElementById("wordToggle")
)
const regexToggle = /** @type {HTMLButtonElement} */ (
	document.getElementById("regexToggle")
)
const prevMatch = /** @type {HTMLButtonElement} */ (
	document.getElementById("prevMatch")
)
const nextMatch = /** @type {HTMLButtonElement} */ (
	document.getElementById("nextMatch")
)
const matchCounter = /** @type {HTMLElement} */ (
	document.getElementById("matchCounter")
)
const statusBar = /** @type {HTMLElement} */ (
	document.getElementById("statusBar")
)
const resultsEl = /** @type {HTMLElement} */ (
	document.getElementById("results")
)
const replaceOne = /** @type {HTMLButtonElement} */ (
	document.getElementById("replaceOne")
)
const replaceAllBtn = /** @type {HTMLButtonElement} */ (
	document.getElementById("replaceAll")
)
const editToggle = /** @type {HTMLButtonElement} */ (
	document.getElementById("editToggle")
)

function syncInputsFromState() {
	patternInput.value = searchState.pattern
	includeInput.value = searchState.include
	excludeInput.value = searchState.exclude
	replaceInput.value = searchState.replace
	caseToggle.classList.toggle("active", searchState.caseSensitive)
	wordToggle.classList.toggle("active", searchState.wholeWord)
	regexToggle.classList.toggle("active", searchState.useRegex)
}

function syncStateFromInputs() {
	searchState.pattern = patternInput.value
	searchState.include = includeInput.value
	searchState.exclude = excludeInput.value
	searchState.replace = replaceInput.value
	searchState.caseSensitive = caseToggle.classList.contains("active")
	searchState.wholeWord = wordToggle.classList.contains("active")
	searchState.useRegex = regexToggle.classList.contains("active")
}

function scheduleSearch() {
	syncStateFromInputs()
	vscode.postMessage({ type: "search", state: searchState })
}

function setStatus(text) {
	statusBar.textContent = text
}

function updateMatchCounter() {
	const total = currentResults?.total ?? 0
	if (total === 0) {
		matchCounter.textContent = "0/0"
		return
	}

	matchCounter.textContent = `${activeMatchIndex + 1}/${total}`
}

/** @returns {SearchMatch[]} */
function flattenMatches() {
	if (!currentResults) {
		return []
	}

	return currentResults.fileResults.flatMap((file) => file.matches)
}

function focusMatch(index) {
	blurActiveEditableLine()
	const matches = flattenMatches()
	if (matches.length === 0) {
		activeMatchIndex = 0
		updateMatchCounter()
		return
	}

	activeMatchIndex =
		((index % matches.length) + matches.length) % matches.length
	updateMatchCounter()
	renderResults()

	const activeEl = document.querySelector(".snippet-line.active")
	if (activeEl) {
		activeEl.scrollIntoView({ block: "center", behavior: "smooth" })
	}
}

function escapeHtml(value) {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
}

/**
 * Extracts sub-spans covering character range [from, to) of the reconstructed line.
 * @param {TokenSpan[]} spans
 * @param {number} from
 * @param {number} to
 * @returns {TokenSpan[]}
 */
function sliceTokenSpans(spans, from, to) {
	const result = []
	let pos = 0
	for (const span of spans) {
		const spanEnd = pos + span.text.length
		if (spanEnd <= from) {
			pos = spanEnd
			continue
		}
		if (pos >= to) break
		const clampStart = Math.max(pos, from)
		const clampEnd = Math.min(spanEnd, to)
		result.push({
			text: span.text.slice(clampStart - pos, clampEnd - pos),
			color: span.color,
		})
		pos = spanEnd
	}
	return result
}

/**
 * Renders an array of TokenSpans as an HTML string with inline color styles.
 * @param {TokenSpan[]} spans
 * @returns {string}
 */
function renderTokenSpans(spans) {
	return spans
		.map((span) => {
			const escaped = escapeHtml(span.text)
			return span.color
				? `<span style="color:${span.color}">${escaped}</span>`
				: escaped
		})
		.join("")
}

/**
 * Renders a line with every match occurrence on it highlighted.
 * @param {string} line
 * @param {Array<{ start: number; end: number; active: boolean }>} ranges
 * @param {TokenSpan[] | undefined} [tokens]
 */
function renderLineContent(line, ranges, tokens) {
	const sorted = [...ranges].sort((a, b) => a.start - b.start)
	const renderSlice = (from, to) =>
		tokens && tokens.length > 0
			? renderTokenSpans(sliceTokenSpans(tokens, from, to))
			: escapeHtml(line.slice(from, to))

	let html = ""
	let pos = 0
	for (const range of sorted) {
		const highlightClass = range.active
			? "match-highlight active-highlight"
			: "match-highlight"
		html += renderSlice(pos, range.start)
		html += `<span class="${highlightClass}">${renderSlice(range.start, range.end)}</span>`
		pos = range.end
	}
	html += renderSlice(pos, line.length)
	return html
}

/** @param {SearchMatch[]} lineMatches */
function matchHighlightRanges(lineMatches) {
	return lineMatches.map((m) => ({
		start: m.matchStart,
		end: m.matchEnd,
		active: m.id === activeMatchIndex,
	}))
}

/** @param {SearchMatch} match */
function getFirstLineNumber(match) {
	if (match.contextBefore.length > 0) {
		return match.contextBefore[0].line
	}
	return match.line
}

/** @param {SearchMatch} match */
function getLastLineNumber(match) {
	if (match.contextAfter.length > 0) {
		return match.contextAfter[match.contextAfter.length - 1].line
	}
	return match.line
}

/** @param {SearchMatch} prev @param {SearchMatch} curr */
function shouldMergeMatches(prev, curr) {
	const prevEffective = getEffectiveMatch(prev).match
	const currEffective = getEffectiveMatch(curr).match
	return (
		getFirstLineNumber(currEffective) <= getLastLineNumber(prevEffective) + 1
	)
}

// Groups consecutive matches whose context windows overlap or touch into a single
// rendered block, avoiding redundant gap lines between closely spaced hits.
/** @param {SearchMatch[]} matches */
function groupMatchesIntoSections(matches) {
	/** @type {SearchMatch[][]} */
	const sections = []
	/** @type {SearchMatch[]} */
	let current = []

	for (const match of matches) {
		if (current.length === 0) {
			current.push(match)
			continue
		}

		const prev = current[current.length - 1]
		if (shouldMergeMatches(prev, match)) {
			current.push(match)
		} else {
			sections.push(current)
			current = [match]
		}
	}

	if (current.length > 0) {
		sections.push(current)
	}

	return sections
}

/**
 * @param {SearchMatch[]} matches
 * @param {string} file
 */
function collectSectionLines(matches, file) {
	/** @type {Map<number, { lineNumber: number; text: string; tokens: TokenSpan[] | undefined; matches: SearchMatch[] }>} */
	const byLine = new Map()

	for (const match of matches) {
		const { match: effective } = getEffectiveMatch(match)

		for (const contextLine of effective.contextBefore) {
			if (!byLine.has(contextLine.line)) {
				byLine.set(contextLine.line, {
					lineNumber: contextLine.line,
					text: contextLine.text,
					tokens:
						contextLine.tokens ??
						contextTokenCache.get(`${file}:${contextLine.line}`),
					matches: [],
				})
			}
		}

		// A line can carry several matches (multiple occurrences of the
		// pattern); collect them all so every occurrence gets highlighted.
		const lineEntry = byLine.get(effective.line)
		if (lineEntry) {
			lineEntry.matches.push(match)
			lineEntry.tokens = lineEntry.tokens ?? effective.tokens
		} else {
			byLine.set(effective.line, {
				lineNumber: effective.line,
				text: effective.lineText,
				tokens: effective.tokens,
				matches: [match],
			})
		}

		for (const contextLine of effective.contextAfter) {
			if (!byLine.has(contextLine.line)) {
				byLine.set(contextLine.line, {
					lineNumber: contextLine.line,
					text: contextLine.text,
					tokens:
						contextLine.tokens ??
						contextTokenCache.get(`${file}:${contextLine.line}`),
					matches: [],
				})
			}
		}
	}

	return [...byLine.values()].sort((a, b) => a.lineNumber - b.lineNumber)
}

/** @param {number} fromLine @param {number} toLine */
function renderSectionGap(fromLine, toLine) {
	const hidden = toLine - fromLine - 1
	if (hidden <= 0) {
		return null
	}

	const gap = document.createElement("div")
	gap.className = "section-gap"
	gap.textContent = `${hidden} line${hidden === 1 ? "" : "s"} not shown`
	return gap
}

/** @param {SearchMatch} match */
function getEffectiveMatch(match) {
	const expanded = expandedSections.get(match.id)
	if (!expanded) {
		return {
			match,
			canExpandBefore: getFirstLineNumber(match) > 1,
			canExpandAfter: true,
		}
	}

	return {
		match: {
			...match,
			contextBefore: expanded.contextBefore,
			contextAfter: expanded.contextAfter,
		},
		canExpandBefore: expanded.canExpandBefore,
		canExpandAfter: expanded.canExpandAfter,
	}
}

function requestExpand(match, direction) {
	const {
		match: effective,
		canExpandBefore,
		canExpandAfter,
	} = getEffectiveMatch(match)
	if (direction === "before" && !canExpandBefore) {
		return
	}
	if (direction === "after" && !canExpandAfter) {
		return
	}

	const anchorLine =
		direction === "before"
			? getFirstLineNumber(effective)
			: getLastLineNumber(effective)

	vscode.postMessage({
		type: "expandMatch",
		matchId: match.id,
		file: match.file,
		direction,
		anchorLine,
		count: EXPAND_STEP,
	})
}

/** @param {'before' | 'after'} direction @param {SearchMatch} match */
function renderExpandButton(direction, match) {
	const { canExpandBefore, canExpandAfter } = getEffectiveMatch(match)
	const canExpand = direction === "before" ? canExpandBefore : canExpandAfter
	if (!canExpand) {
		return null
	}

	const button = document.createElement("button")
	button.type = "button"
	button.className = `expand-context expand-${direction}`
	button.title =
		direction === "before"
			? `Show ${EXPAND_STEP} more lines above`
			: `Show ${EXPAND_STEP} more lines below`
	button.setAttribute("aria-label", button.title)

	const icon = document.createElement("span")
	icon.className = `codicon codicon-chevron-${direction === "before" ? "up" : "down"}`
	button.appendChild(icon)

	button.addEventListener("click", (event) => {
		event.stopPropagation()
		requestExpand(match, direction)
	})
	return button
}

/**
 * @param {string} file
 * @param {number} lineNumber
 * @param {string} newText
 */
function updateLineInDataModel(file, lineNumber, newText) {
	if (!currentResults) return
	for (const fileResult of currentResults.fileResults) {
		if (fileResult.file !== file) continue
		for (const match of fileResult.matches) {
			if (match.line === lineNumber) {
				match.lineText = newText
				match.tokens = undefined
			}
			for (const ctx of match.contextBefore) {
				if (ctx.line === lineNumber) {
					ctx.text = newText
					ctx.tokens = undefined
				}
			}
			for (const ctx of match.contextAfter) {
				if (ctx.line === lineNumber) {
					ctx.text = newText
					ctx.tokens = undefined
				}
			}
		}
	}
	for (const [matchId, expanded] of expandedSections) {
		if (matchById.get(matchId)?.file !== file) continue
		for (const ctx of [...expanded.contextBefore, ...expanded.contextAfter]) {
			if (ctx.line === lineNumber) {
				ctx.text = newText
				ctx.tokens = undefined
			}
		}
	}
	contextTokenCache.delete(`${file}:${lineNumber}`)
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
	renderResults()
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
	renderResults()
	const mergedContent = findLineContent(file, lineNumber - 1)
	if (mergedContent) {
		mergedContent.focus()
		setCaretOffset(mergedContent, prevText.length)
		requestLineTokens(mergedContent, file, lineNumber - 1)
	}
	return true
}

/** @param {SearchMatch[]} matches */
function renderMatchSection(matches) {
	const _vscode = /** @type {{ postMessage(msg: unknown): void }} */ (
		/** @type {unknown} */ (vscode)
	)
	const firstMatch = matches[0]
	const lastMatch = matches[matches.length - 1]
	const file = firstMatch.file
	const block = document.createElement("div")
	block.className = "match-block"
	block.dataset.matchId = String(firstMatch.id)
	block.dataset.file = file

	const expandBefore = renderExpandButton("before", firstMatch)
	if (expandBefore) {
		block.appendChild(expandBefore)
	}

	const lines = collectSectionLines(matches, file)
	const snippet = document.createElement("div")
	snippet.className = "snippet"

	for (const entry of lines) {
		const lineMatches = entry.matches
		const isActive = lineMatches.some((m) => m.id === activeMatchIndex)
		const row = document.createElement("div")
		row.className = `snippet-line${isActive ? " active" : ""}`

		if (lineMatches.length > 0) {
			row.dataset.rowMatchId = String(lineMatches[0].id)
		} else {
			row.dataset.contextLine = String(entry.lineNumber)
		}

		const lineNumber = document.createElement("span")
		lineNumber.className = "line-number"
		lineNumber.textContent = String(entry.lineNumber)

		const content = document.createElement("span")
		content.className = "line-content"
		if (lineMatches.length > 0) {
			content.innerHTML = renderLineContent(
				entry.text,
				matchHighlightRanges(lineMatches),
				entry.tokens,
			)
		} else if (entry.tokens && entry.tokens.length > 0) {
			content.innerHTML = renderTokenSpans(entry.tokens)
		} else {
			content.textContent = entry.text
		}

		row.appendChild(lineNumber)
		row.appendChild(content)

		const match = lineMatches.length > 0 ? lineMatches[0] : null

		if (editMode) {
			const originalText = entry.text
			// `baseline` is the last text applied to the document for this line;
			// commits diff against it so flushing (Ctrl/Cmd+S) and blur never
			// double-apply the same edit.
			const editState = { baseline: entry.text }
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
				updateLineInDataModel(file, entry.lineNumber, newText)
				_vscode.postMessage({
					type: "editLine",
					file,
					line: entry.lineNumber,
					newContent: newText,
				})
				// Re-tokenize the committed text so the rendered spans and the
				// result model regain accurate highlighting.
				requestLineTokens(content, file, entry.lineNumber)
				return true
			}
			lineCommitters.set(content, commitLine)

			content.addEventListener("focus", () => {
				content.dataset.savedHtml = content.innerHTML
			})

			content.addEventListener("input", () => {
				scheduleLineTokens(content, file, entry.lineNumber)
			})

			content.addEventListener("blur", () => {
				cancelScheduledLineTokens(file, entry.lineNumber)
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
					handleLineSplit(content, editState, file, entry.lineNumber)
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
						requestLineTokens(content, file, entry.lineNumber)
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
						handleLineJoin(content, editState, file, entry.lineNumber)
					) {
						e.preventDefault()
					}
				} else if (e.key === "Tab") {
					e.preventDefault()
					document.execCommand("insertText", false, "\t")
				}
			})

			if (match) {
				lineNumber.addEventListener("click", () => {
					activeMatchIndex = match.id
					updateMatchCounter()
					renderResults()
					_vscode.postMessage({
						type: "openMatch",
						file: match.file,
						line: match.line,
						column: match.column,
					})
				})
			}
		} else {
			if (match) {
				row.addEventListener("click", () => {
					activeMatchIndex = match.id
					updateMatchCounter()
					renderResults()
					_vscode.postMessage({
						type: "openMatch",
						file: match.file,
						line: match.line,
						column: match.column,
					})
				})
			}
		}

		snippet.appendChild(row)
	}

	block.appendChild(snippet)

	const expandAfter = renderExpandButton("after", lastMatch)
	if (expandAfter) {
		block.appendChild(expandAfter)
	}

	if (firstMatch.breadcrumb) {
		const meta = document.createElement("div")
		meta.className = "match-meta"
		meta.textContent = firstMatch.breadcrumb
		block.appendChild(meta)
	}

	// Register with IntersectionObserver so context tokens are loaded lazily
	const allContextLines = []
	for (const match of matches) {
		const { match: effective } = getEffectiveMatch(match)
		for (const ctx of effective.contextBefore) {
			if (!allContextLines.some((l) => l.line === ctx.line)) {
				allContextLines.push({ line: ctx.line, text: ctx.text })
			}
		}
		for (const ctx of effective.contextAfter) {
			if (!allContextLines.some((l) => l.line === ctx.line)) {
				allContextLines.push({ line: ctx.line, text: ctx.text })
			}
		}
	}
	if (allContextLines.length > 0) {
		blockContextMeta.set(block, {
			file,
			lines: allContextLines,
			firstMatchId: firstMatch.id,
		})
		contextObserver.observe(block)
	}

	return block
}

function renderSplash() {
	const el = document.createElement("div")
	el.className = "splash"
	el.innerHTML = `
		<span class="splash-icon codicon codicon-search"></span>
		<span class="splash-headline">Search your workspace</span>
		<span class="splash-subtitle">Type a query to find matches across all files in the project</span>
	`
	return el
}

function renderResults() {
	contextObserver.disconnect()
	resultsEl.innerHTML = ""
	resultsEl.classList.toggle("edit-mode", editMode)

	if (!currentResults || currentResults.total === 0) {
		if (patternInput.value.trim()) {
			const empty = document.createElement("div")
			empty.className = "empty-state"
			empty.textContent = "No results found"
			resultsEl.appendChild(empty)
		} else {
			resultsEl.appendChild(renderSplash())
		}
		return
	}

	for (const fileResult of currentResults.fileResults) {
		const group = document.createElement("section")
		group.className = "file-group"

		const header = document.createElement("div")
		header.className = "file-header"

		let icon
		if (fileResult.iconUri) {
			icon = document.createElement("img")
			icon.className = "file-icon file-icon-img"
			icon.src = fileResult.iconUri
			icon.alt = ""
		} else if (fileResult.iconFont) {
			icon = document.createElement("span")
			icon.className = "file-icon file-icon-font"
			icon.style.fontFamily = `'${fileResult.iconFont.family}'`
			icon.style.color = fileResult.iconFont.color
			icon.textContent = fileResult.iconFont.char
		} else {
			icon = document.createElement("span")
			icon.className = "file-icon codicon codicon-file"
		}

		const name = document.createElement("span")
		name.className = "file-name"
		name.textContent = fileResult.fileName

		const path = document.createElement("span")
		path.className = "file-path"
		path.textContent = fileResult.directory ? `${fileResult.directory}/` : ""

		const breadcrumb = document.createElement("span")
		breadcrumb.className = "file-breadcrumb"
		breadcrumb.textContent = fileResult.matches[0]?.breadcrumb ?? ""

		const openButton = document.createElement("button")
		openButton.className = "open-file"
		openButton.textContent = "Open File"
		openButton.addEventListener("click", () => {
			const firstMatch = fileResult.matches[0]
			if (firstMatch) {
				vscode.postMessage({
					type: "openMatch",
					file: firstMatch.file,
					line: firstMatch.line,
					column: firstMatch.column,
				})
			}
		})

		header.appendChild(icon)
		header.appendChild(name)
		header.appendChild(path)
		header.appendChild(breadcrumb)
		header.appendChild(openButton)
		group.appendChild(header)

		const sections = groupMatchesIntoSections(fileResult.matches)
		for (let i = 0; i < sections.length; i++) {
			if (i > 0) {
				const prevSection = sections[i - 1]
				const currSection = sections[i]
				const prevLast = getLastLineNumber(
					getEffectiveMatch(prevSection[prevSection.length - 1]).match,
				)
				const currFirst = getFirstLineNumber(
					getEffectiveMatch(currSection[0]).match,
				)
				const gap = renderSectionGap(prevLast, currFirst)
				if (gap) {
					group.appendChild(gap)
				}
			}
			group.appendChild(renderMatchSection(sections[i]))
		}

		resultsEl.appendChild(group)
	}
}

for (const input of [patternInput, includeInput, excludeInput]) {
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter") scheduleSearch()
	})
}

replaceInput.addEventListener("input", syncStateFromInputs)

for (const toggle of [caseToggle, wordToggle, regexToggle]) {
	toggle.addEventListener("click", () => {
		toggle.classList.toggle("active")
		scheduleSearch()
	})
}

prevMatch.addEventListener("click", () => focusMatch(activeMatchIndex - 1))
nextMatch.addEventListener("click", () => focusMatch(activeMatchIndex + 1))

editToggle.addEventListener("click", () => {
	blurActiveEditableLine()
	editMode = !editMode
	editToggle.classList.toggle("active", editMode)
	renderResults()
})

replaceOne.addEventListener("click", () => {
	const matches = flattenMatches()
	const match = matches[activeMatchIndex]
	if (!match) {
		return
	}

	vscode.postMessage({
		type: "replaceMatch",
		file: match.file,
		line: match.line,
		column: match.matchStart,
		length: match.matchEnd - match.matchStart,
		replacement: searchState.replace,
	})
})

replaceAllBtn.addEventListener("click", () => {
	syncStateFromInputs()
	vscode.postMessage({ type: "replaceAll", state: searchState })
})

document.addEventListener("keydown", (event) => {
	if (event.key === "F4" || (event.key === "g" && event.ctrlKey)) {
		event.preventDefault()
		focusMatch(activeMatchIndex + (event.shiftKey ? -1 : 1))
	}
	if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
		event.preventDefault()
		// Commit the focused line first so the save includes what's being typed.
		flushActiveLineEdit()
		vscode.postMessage({ type: "saveEdits" })
	}
})

// IPC bridge — receives messages posted by the extension host via webview.postMessage().
window.addEventListener("message", (event) => {
	const message = event.data

	switch (message.type) {
		case "init":
			if (message.state) {
				searchState = { ...searchState, ...message.state }
			}
			syncInputsFromState()
			if (searchState.pattern.trim()) {
				scheduleSearch()
			} else {
				renderResults()
				updateMatchCounter()
			}
			break
		case "searching":
			setStatus("Searching…")
			break
		case "results": {
			currentResults = message.results
			rebuildMatchIndexes()
			expandedSections.clear()
			contextTokenCache.clear()
			contextTokenRequested.clear()
			activeMatchIndex = 0
			renderResults()
			updateMatchCounter()
			setStatus(
				message.results.truncated
					? `${message.results.total}+ results (truncated)`
					: `${message.results.total} result${message.results.total === 1 ? "" : "s"} in ${message.results.fileResults.length} file${message.results.fileResults.length === 1 ? "" : "s"}`,
			)
			break
		}
		case "error":
			setStatus(message.message)
			break
		case "replaced":
			setStatus(
				`Replaced ${message.count} occurrence${message.count === 1 ? "" : "s"}`,
			)
			scheduleSearch()
			break
		case "matchTokens": {
			if (currentResults?.queryId !== message.queryId) break
			for (const { matchId, tokens } of message.tokens) {
				const match = matchById.get(matchId)
				if (!match) continue
				match.tokens = tokens
				// The row carries the id of the first match on its line; resolve
				// through the line's match list so any occurrence's tokens update it.
				const lineMatches = matchesByFileLine.get(
					`${match.file}:${match.line}`,
				) ?? [match]
				const row = resultsEl.querySelector(
					`[data-row-match-id="${lineMatches[0].id}"]`,
				)
				if (!row) continue
				const content = row.querySelector(".line-content")
				if (!content || content === document.activeElement) continue
				content.innerHTML = renderLineContent(
					match.lineText,
					matchHighlightRanges(lineMatches),
					tokens,
				)
			}
			break
		}
		case "contextTokens": {
			for (const { line, tokens } of message.tokensByLine) {
				contextTokenCache.set(`${message.file}:${line}`, tokens)
			}
			// Update context line DOM rows directly without a full re-render
			for (const block of resultsEl.querySelectorAll(".match-block")) {
				if (block.dataset.file !== message.file) continue
				for (const { line, tokens } of message.tokensByLine) {
					const row = block.querySelector(`[data-context-line="${line}"]`)
					if (!row) continue
					const content = row.querySelector(".line-content")
					if (
						content &&
						content !== document.activeElement &&
						tokens.length > 0
					) {
						content.innerHTML = renderTokenSpans(tokens)
					}
				}
			}
			break
		}
		case "lineEdited":
			setStatus("Unsaved changes — press Ctrl/Cmd+S to save")
			break
		case "editsSaved":
			setStatus(
				message.count > 0
					? `Saved ${message.count} file${message.count === 1 ? "" : "s"}`
					: "No unsaved changes",
			)
			break
		case "lineTokens": {
			const content = findLineContent(message.file, message.line)
			if (!content) break
			// Stale response — the line changed again since this was requested.
			if ((content.textContent ?? "") !== message.text) break
			storeLineTokens(message.file, message.line, message.text, message.tokens)
			const focused = content === document.activeElement
			const caret = focused ? getCaretOffset(content) : null
			content.innerHTML =
				message.tokens.length > 0
					? renderTokenSpans(message.tokens)
					: escapeHtml(message.text)
			if (focused && caret !== null) setCaretOffset(content, caret)
			break
		}
		case "expanded": {
			const match = flattenMatches().find(
				(entry) => entry.id === message.matchId,
			)
			if (!match) {
				break
			}

			let state = expandedSections.get(message.matchId)
			if (!state) {
				state = {
					contextBefore: [...match.contextBefore],
					contextAfter: [...match.contextAfter],
					canExpandBefore: getFirstLineNumber(match) > 1,
					canExpandAfter: true,
				}
				expandedSections.set(message.matchId, state)
			}

			if (message.direction === "before") {
				state.contextBefore = [...message.lines, ...state.contextBefore]
				state.canExpandBefore = message.hasMore
			} else {
				state.contextAfter = [...state.contextAfter, ...message.lines]
				state.canExpandAfter = message.hasMore
			}

			renderResults()
			break
		}
	}
})

// Signal to the extension host that the webview DOM is ready and can receive messages.
vscode.postMessage({ type: "ready" })
