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
/** @typedef {{ line: number; text: string }} ContextLine */
/** @typedef {{ id: number; file: string; relativePath: string; line: number; column: number; lineText: string; matchStart: number; matchEnd: number; contextBefore: ContextLine[]; contextAfter: ContextLine[]; breadcrumb: string }} SearchMatch */
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
	exclude: "node_modules/**, *.lock",
	caseSensitive: false,
	wholeWord: false,
	useRegex: false,
	replace: "",
}
/** @type {SearchResults | null} */
let currentResults = null
/** @type {number} */
let activeMatchIndex = 0
/** @type {ReturnType<typeof setTimeout> | undefined} */
let searchDebounce

// Number of lines to reveal each time the user clicks an expand-context button.
const EXPAND_STEP = 10

/** @typedef {{ contextBefore: ContextLine[]; contextAfter: ContextLine[]; canExpandBefore: boolean; canExpandAfter: boolean }} ExpandedSection */

// Keyed by match ID. Tracks context lines that have been expanded beyond what
// the initial search result included, so re-renders don't lose that state.
/** @type {Map<number, ExpandedSection>} */
const expandedSections = new Map()

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

// Debounces search requests so we don't flood the extension host on every keystroke.
function scheduleSearch() {
	syncStateFromInputs()
	clearTimeout(searchDebounce)
	searchDebounce = setTimeout(() => {
		vscode.postMessage({ type: "search", state: searchState })
	}, 250)
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

/** @param {string} line @param {number} start @param {number} end @param {boolean} isActive */
function renderLineContent(line, start, end, isActive) {
	const before = escapeHtml(line.slice(0, start))
	const match = escapeHtml(line.slice(start, end))
	const after = escapeHtml(line.slice(end))
	const highlightClass = isActive ? "match-highlight" : "match-highlight"
	return `${before}<span class="${highlightClass}">${match}</span>${after}`
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

/** @param {SearchMatch[]} matches */
function collectSectionLines(matches) {
	/** @type {Map<number, { lineNumber: number; text: string; match: SearchMatch | null }>} */
	const byLine = new Map()

	for (const match of matches) {
		const { match: effective } = getEffectiveMatch(match)

		for (const contextLine of effective.contextBefore) {
			if (!byLine.has(contextLine.line)) {
				byLine.set(contextLine.line, {
					lineNumber: contextLine.line,
					text: contextLine.text,
					match: null,
				})
			}
		}

		if (!byLine.has(effective.line)) {
			byLine.set(effective.line, {
				lineNumber: effective.line,
				text: effective.lineText,
				match,
			})
		}

		for (const contextLine of effective.contextAfter) {
			if (!byLine.has(contextLine.line)) {
				byLine.set(contextLine.line, {
					lineNumber: contextLine.line,
					text: contextLine.text,
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
	const block = document.createElement("div")
	block.className = "match-block"
	block.dataset.matchId = String(firstMatch.id)

	const expandBefore = renderExpandButton("before", firstMatch)
	if (expandBefore) {
		block.appendChild(expandBefore)
	}

	const lines = collectSectionLines(matches)
	const snippet = document.createElement("div")
	snippet.className = "snippet"

	for (const entry of lines) {
		const match = entry.match
		const isActive = match != null && match.id === activeMatchIndex
		const row = document.createElement("div")
		row.className = `snippet-line${isActive ? " active" : ""}`

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
			)
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

	return block
}

function renderResults() {
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

		const icon = document.createElement("span")
		icon.className = "file-icon"
		icon.textContent = "📄"

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

patternInput.addEventListener("input", scheduleSearch)
includeInput.addEventListener("input", scheduleSearch)
excludeInput.addEventListener("input", scheduleSearch)

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
	if (event.key === "Enter" && document.activeElement === patternInput) {
		clearTimeout(searchDebounce)
		syncStateFromInputs()
		vscode.postMessage({ type: "search", state: searchState })
	}

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
			expandedSections.clear()
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
