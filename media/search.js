// @ts-check
/// <reference lib="dom" />

// Webview UI entry point for the FullTab Search panel.
//
// VS Code extension webviews run in a sandboxed browser context — no Node.js,
// no direct VS Code API access, and no access to the extension host's memory.
// These files live in media/ so the extension can load them as static assets;
// this module is referenced by a <script type="module"> tag whose CSP nonce
// covers its static imports. All communication with the extension host goes
// through the postMessage / onDidReceiveMessage IPC bridge (see ipc.js).
//
// This module wires the toolbar and keyboard events and dispatches incoming
// messages; the heavy lifting lives in the sibling modules:
//   model.js     result data model and its mutations
//   render.js    result list rendering
//   editing.js   edit mode (contenteditable lines)
//   highlight.js line HTML rendering (tokens + match highlights)
//   tokens.js    async tokenization plumbing
//   ui.js        toolbar/status element lookups and sync helpers
//   caret.js     caret/selection offset utilities

import { getCaretOffset, setCaretOffset } from "./caret.js"
import {
	blurActiveEditableLine,
	findLineContent,
	flushActiveLineEdit,
	setRerender,
} from "./editing.js"
import {
	escapeHtml,
	matchHighlightRanges,
	renderLineContent,
	renderTokenSpans,
} from "./highlight.js"
import { vscode } from "./ipc.js"
import {
	contextTokenCache,
	expandedSections,
	flattenMatches,
	getFirstLineNumber,
	rebuildMatchIndexes,
	state,
	storeLineTokens,
} from "./model.js"
import { focusMatch, renderResults } from "./render.js"
import {
	caseToggle,
	editToggle,
	excludeInput,
	includeInput,
	nextMatch,
	patternInput,
	prevMatch,
	regexToggle,
	replaceAllBtn,
	replaceInput,
	replaceOne,
	resultsEl,
	scheduleSearch,
	setStatus,
	syncInputsFromState,
	syncStateFromInputs,
	updateMatchCounter,
	wordToggle,
} from "./ui.js"

// Line splits/joins in editing.js need a full re-render; injected here to
// keep the editing → render import edge out of the graph.
setRerender(renderResults)

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

prevMatch.addEventListener("click", () =>
	focusMatch(state.activeMatchIndex - 1),
)
nextMatch.addEventListener("click", () =>
	focusMatch(state.activeMatchIndex + 1),
)

editToggle.addEventListener("click", () => {
	blurActiveEditableLine()
	state.editMode = !state.editMode
	editToggle.classList.toggle("active", state.editMode)
	renderResults()
})

replaceOne.addEventListener("click", () => {
	const matches = flattenMatches()
	const match = matches[state.activeMatchIndex]
	if (!match) {
		return
	}

	vscode.postMessage({
		type: "replaceMatch",
		file: match.file,
		line: match.line,
		column: match.matchStart,
		length: match.matchEnd - match.matchStart,
		replacement: state.searchState.replace,
	})
})

replaceAllBtn.addEventListener("click", () => {
	syncStateFromInputs()
	vscode.postMessage({ type: "replaceAll", state: state.searchState })
})

document.addEventListener("keydown", (event) => {
	if (event.key === "F4" || (event.key === "g" && event.ctrlKey)) {
		event.preventDefault()
		focusMatch(state.activeMatchIndex + (event.shiftKey ? -1 : 1))
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
				state.searchState = { ...state.searchState, ...message.state }
			}
			syncInputsFromState()
			if (state.searchState.pattern.trim()) {
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
			state.currentResults = message.results
			rebuildMatchIndexes()
			state.collapsedFiles.clear()
			expandedSections.clear()
			contextTokenCache.clear()
			state.activeMatchIndex = 0
			renderResults()
			updateMatchCounter()
			const resultsSummary = message.results.truncated
				? `${message.results.total}+ results (truncated)`
				: `${message.results.total} result${message.results.total === 1 ? "" : "s"} in ${message.results.fileResults.length} file${message.results.fileResults.length === 1 ? "" : "s"}`
			setStatus(
				message.results.warning
					? `${resultsSummary} — ${message.results.warning}`
					: resultsSummary,
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
			if (state.currentResults?.queryId !== message.queryId) break
			for (const { matchId, tokens } of message.tokens) {
				const match = state.matchById.get(matchId)
				if (!match) continue
				match.tokens = tokens
				// The row carries the id of the first match on its line; resolve
				// through the line's match list so any occurrence's tokens update it.
				const lineMatches = state.matchesByFileLine.get(
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

			let expandState = expandedSections.get(message.matchId)
			if (!expandState) {
				expandState = {
					contextBefore: [...match.contextBefore],
					contextAfter: [...match.contextAfter],
					canExpandBefore: getFirstLineNumber(match) > 1,
					canExpandAfter: true,
				}
				expandedSections.set(message.matchId, expandState)
			}

			if (message.direction === "before") {
				expandState.contextBefore = [
					...message.lines,
					...expandState.contextBefore,
				]
				expandState.canExpandBefore = message.hasMore
			} else {
				expandState.contextAfter = [
					...expandState.contextAfter,
					...message.lines,
				]
				expandState.canExpandAfter = message.hasMore
			}

			renderResults()
			break
		}
	}
})

// Signal to the extension host that the webview DOM is ready and can receive messages.
vscode.postMessage({ type: "ready" })
