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
/** @type {number} */
let activeMatchIndex = 0

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
 * @param {string} line
 * @param {number} start
 * @param {number} end
 * @param {boolean} isActive
 * @param {TokenSpan[] | undefined} [tokens]
 */
function renderLineContent(line, start, end, isActive, tokens) {
	const highlightClass = isActive
		? "match-highlight active-highlight"
		: "match-highlight"
	if (!tokens || tokens.length === 0) {
		const before = escapeHtml(line.slice(0, start))
		const match = escapeHtml(line.slice(start, end))
		const after = escapeHtml(line.slice(end))
		return `${before}<span class="${highlightClass}">${match}</span>${after}`
	}
	const beforeSpans = sliceTokenSpans(tokens, 0, start)
	const matchSpans = sliceTokenSpans(tokens, start, end)
	const afterSpans = sliceTokenSpans(tokens, end, line.length)
	return (
		renderTokenSpans(beforeSpans) +
		`<span class="${highlightClass}">${renderTokenSpans(matchSpans)}</span>` +
		renderTokenSpans(afterSpans)
	)
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
	/** @type {Map<number, { lineNumber: number; text: string; tokens: TokenSpan[] | undefined; match: SearchMatch | null }>} */
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
					match: null,
				})
			}
		}

		if (!byLine.has(effective.line)) {
			byLine.set(effective.line, {
				lineNumber: effective.line,
				text: effective.lineText,
				tokens: effective.tokens,
				match,
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
					match: null,
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

/** @param {SearchMatch[]} matches */
function renderMatchSection(matches) {
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
		const match = entry.match
		const isActive = match != null && match.id === activeMatchIndex
		const row = document.createElement("div")
		row.className = `snippet-line${isActive ? " active" : ""}`

		if (match) {
			row.dataset.rowMatchId = String(match.id)
		} else {
			row.dataset.contextLine = String(entry.lineNumber)
		}

		const lineNumber = document.createElement("span")
		lineNumber.className = "line-number"
		lineNumber.textContent = String(entry.lineNumber)

		const content = document.createElement("span")
		content.className = "line-content"
		if (match) {
			content.innerHTML = renderLineContent(
				entry.text,
				match.matchStart,
				match.matchEnd,
				isActive,
				entry.tokens,
			)
		} else if (entry.tokens && entry.tokens.length > 0) {
			content.innerHTML = renderTokenSpans(entry.tokens)
		} else {
			content.textContent = entry.text
		}

		row.appendChild(lineNumber)
		row.appendChild(content)

		if (match) {
			row.addEventListener("click", () => {
				activeMatchIndex = match.id
				updateMatchCounter()
				renderResults()
				vscode.postMessage({
					type: "openMatch",
					file: match.file,
					line: match.line,
					column: match.column,
				})
			})
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

function renderResults() {
	contextObserver.disconnect()
	resultsEl.innerHTML = ""

	if (!currentResults || currentResults.total === 0) {
		const empty = document.createElement("div")
		empty.className = "empty-state"
		empty.textContent = patternInput.value.trim()
			? "No results found"
			: "Enter a search query to search across your workspace"
		resultsEl.appendChild(empty)
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
		case "results":
			currentResults = message.results
			matchById = new Map(
				currentResults.fileResults
					.flatMap((f) => f.matches)
					.map((m) => [m.id, m]),
			)
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
				const row = resultsEl.querySelector(`[data-row-match-id="${matchId}"]`)
				if (!row) continue
				const content = row.querySelector(".line-content")
				if (!content) continue
				const isActive = matchId === activeMatchIndex
				content.innerHTML = renderLineContent(
					match.lineText,
					match.matchStart,
					match.matchEnd,
					isActive,
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
					if (content && tokens.length > 0) {
						content.innerHTML = renderTokenSpans(tokens)
					}
				}
			}
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
