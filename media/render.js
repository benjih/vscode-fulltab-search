// @ts-check
/// <reference lib="dom" />

// Renders the result list into #results: file groups, match sections with
// shared context windows, gap markers, and expand-context buttons.

import { blurActiveEditableLine, wireEditableLine } from "./editing.js"
import {
	matchHighlightRanges,
	renderLineContent,
	renderTokenSpans,
} from "./highlight.js"
import { vscode } from "./ipc.js"
import {
	contextTokenCache,
	EXPAND_STEP,
	flattenMatches,
	getEffectiveMatch,
	getFirstLineNumber,
	getLastLineNumber,
	state,
} from "./model.js"
import { disconnectContextObserver, observeBlockContext } from "./tokens.js"
import { patternInput, resultsEl, updateMatchCounter } from "./ui.js"

/** @typedef {import("./types.js").TokenSpan} TokenSpan */
/** @typedef {import("./types.js").SearchMatch} SearchMatch */
/** @typedef {import("./types.js").ContextLine} ContextLine */

/**
 * Moves the active marker to the match with `matchId` by swapping the
 * `.active` / `.active-highlight` classes in place, avoiding a full DOM
 * rebuild. Returns false when the target match isn't currently rendered
 * (e.g. it lives in a collapsed group), signalling that the caller should
 * fall back to renderResults().
 * @param {number} matchId
 */
function applyActiveMatch(matchId) {
	const target = resultsEl.querySelector(
		`.snippet-line [data-match-id="${matchId}"]`,
	)
	if (!target) {
		return false
	}

	for (const span of resultsEl.querySelectorAll(".active-highlight")) {
		span.classList.remove("active-highlight")
	}
	for (const row of resultsEl.querySelectorAll(".snippet-line.active")) {
		row.classList.remove("active")
	}

	target.classList.add("active-highlight")
	target.closest(".snippet-line")?.classList.add("active")
	return true
}

export function focusMatch(index) {
	blurActiveEditableLine()
	const matches = flattenMatches()
	if (matches.length === 0) {
		state.activeMatchIndex = 0
		updateMatchCounter()
		return
	}

	state.activeMatchIndex =
		((index % matches.length) + matches.length) % matches.length
	updateMatchCounter()

	// Navigating into a collapsed file group reveals it and needs a full
	// re-render; otherwise just move the active marker between rows.
	const active = matches.find((m) => m.id === state.activeMatchIndex)
	if (active && state.collapsedFiles.has(active.file)) {
		state.collapsedFiles.delete(active.file)
		renderResults()
	} else if (!applyActiveMatch(state.activeMatchIndex)) {
		renderResults()
	}

	const activeEl = resultsEl.querySelector(".snippet-line.active")
	if (activeEl) {
		activeEl.scrollIntoView({ block: "center", behavior: "smooth" })
	}
}

/**
 * Marks `match` active and asks the extension to open it in an editor.
 * @param {SearchMatch} match
 */
function activateMatch(match) {
	state.activeMatchIndex = match.id
	updateMatchCounter()
	// The clicked row is already rendered, so an in-place swap suffices.
	if (!applyActiveMatch(match.id)) {
		renderResults()
	}
	vscode.postMessage({
		type: "openMatch",
		file: match.file,
		line: match.line,
		column: match.column,
	})
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

/** @typedef {{ lineNumber: number; text: string; tokens: TokenSpan[] | undefined; matches: SearchMatch[] }} SectionLine */

/**
 * @param {Map<number, SectionLine>} byLine
 * @param {string} file
 * @param {ContextLine} contextLine
 */
function addContextLine(byLine, file, contextLine) {
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

/**
 * @param {SearchMatch[]} matches
 * @param {string} file
 */
function collectSectionLines(matches, file) {
	/** @type {Map<number, SectionLine>} */
	const byLine = new Map()

	for (const match of matches) {
		const { match: effective } = getEffectiveMatch(match)

		for (const contextLine of effective.contextBefore) {
			addContextLine(byLine, file, contextLine)
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
			addContextLine(byLine, file, contextLine)
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
		const lineMatches = entry.matches
		const isActive = lineMatches.some((m) => m.id === state.activeMatchIndex)
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

		if (state.editMode) {
			wireEditableLine(content, file, entry.lineNumber, entry.text)
			if (match) {
				lineNumber.addEventListener("click", () => activateMatch(match))
			}
		} else if (match) {
			row.addEventListener("click", () => activateMatch(match))
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
	const allContextLines = lines
		.filter((entry) => entry.matches.length === 0)
		.map((entry) => ({ line: entry.lineNumber, text: entry.text }))
	if (allContextLines.length > 0) {
		observeBlockContext(block, {
			file,
			lines: allContextLines,
			firstMatchId: firstMatch.id,
		})
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

export function renderResults() {
	disconnectContextObserver()
	resultsEl.innerHTML = ""
	resultsEl.classList.toggle("edit-mode", state.editMode)

	if (!state.currentResults || state.currentResults.total === 0) {
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

	for (const fileResult of state.currentResults.fileResults) {
		const collapsed = state.collapsedFiles.has(fileResult.file)
		const group = document.createElement("section")
		group.className = `file-group${collapsed ? " collapsed" : ""}`

		const header = document.createElement("div")
		header.className = "file-header"
		header.title = collapsed ? "Expand results" : "Collapse results"
		header.addEventListener("click", () => {
			if (collapsed) {
				state.collapsedFiles.delete(fileResult.file)
			} else {
				state.collapsedFiles.add(fileResult.file)
			}
			renderResults()
		})

		const chevron = document.createElement("span")
		chevron.className = `collapse-chevron codicon codicon-chevron-${collapsed ? "right" : "down"}`

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

		const count = document.createElement("span")
		count.className = "match-count"
		count.textContent = String(fileResult.matches.length)

		const openButton = document.createElement("button")
		openButton.className = "open-file"
		openButton.textContent = "Open File"
		openButton.addEventListener("click", (event) => {
			event.stopPropagation()
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

		header.appendChild(chevron)
		header.appendChild(icon)
		header.appendChild(name)
		header.appendChild(path)
		header.appendChild(breadcrumb)
		header.appendChild(count)
		header.appendChild(openButton)
		group.appendChild(header)

		if (collapsed) {
			resultsEl.appendChild(group)
			continue
		}

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
