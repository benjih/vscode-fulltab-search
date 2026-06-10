// @ts-check
/// <reference lib="dom" />

// The webview's result data model: current search state, results, indexes,
// and every mutation the UI applies to them (inline edits, line splits and
// joins, token storage). Rendering stays out of this module.

/** @typedef {import("./types.js").SearchState} SearchState */
/** @typedef {import("./types.js").TokenSpan} TokenSpan */
/** @typedef {import("./types.js").ContextLine} ContextLine */
/** @typedef {import("./types.js").SearchMatch} SearchMatch */
/** @typedef {import("./types.js").SearchResults} SearchResults */
/** @typedef {import("./types.js").ExpandedSection} ExpandedSection */

// Number of lines to reveal each time the user clicks an expand-context button.
export const EXPAND_STEP = 10

// Mutable UI state. ES module exports are read-only bindings, so the mutable
// fields live on this shared object and consumers update it in place.
export const state = {
	/** @type {SearchState} */
	searchState: {
		pattern: "",
		include: "",
		exclude: "",
		caseSensitive: false,
		wholeWord: false,
		useRegex: false,
		replace: "",
	},
	/** @type {SearchResults | null} */
	currentResults: null,
	/** @type {Map<number, SearchMatch>} */
	matchById: new Map(),
	/** @type {Map<string, SearchMatch[]>} keyed by "file:lineNumber" — all matches on that line */
	matchesByFileLine: new Map(),
	/** @type {number} */
	activeMatchIndex: 0,
	/** @type {boolean} */
	editMode: false,
	/** @type {Set<string>} file paths whose result group is collapsed */
	collapsedFiles: new Set(),
}

// Keyed by match ID. Tracks context lines that have been expanded beyond what
// the initial search result included, so re-renders don't lose that state.
/** @type {Map<number, ExpandedSection>} */
export const expandedSections = new Map()

/** @type {Map<string, TokenSpan[]>} keyed by "file:lineNumber" */
export const contextTokenCache = new Map()

// Rebuilds matchById / matchesByFileLine, e.g. after line numbers shift.
export function rebuildMatchIndexes() {
	const allMatches = state.currentResults
		? state.currentResults.fileResults.flatMap((f) => f.matches)
		: []
	state.matchById = new Map(allMatches.map((m) => [m.id, m]))
	state.matchesByFileLine = new Map()
	for (const m of allMatches) {
		const key = `${m.file}:${m.line}`
		const existing = state.matchesByFileLine.get(key)
		if (existing) {
			existing.push(m)
		} else {
			state.matchesByFileLine.set(key, [m])
		}
	}
}

/** @returns {SearchMatch[]} */
export function flattenMatches() {
	if (!state.currentResults) {
		return []
	}

	return state.currentResults.fileResults.flatMap((file) => file.matches)
}

/** @param {SearchMatch} match */
export function getFirstLineNumber(match) {
	if (match.contextBefore.length > 0) {
		return match.contextBefore[0].line
	}
	return match.line
}

/** @param {SearchMatch} match */
export function getLastLineNumber(match) {
	if (match.contextAfter.length > 0) {
		return match.contextAfter[match.contextAfter.length - 1].line
	}
	return match.line
}

/** @param {SearchMatch} match */
export function getEffectiveMatch(match) {
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
 * Yields every match in `file`'s results together with all context-line
 * arrays attached to it: the base contextBefore/contextAfter plus the
 * expanded copies, if any.
 * @param {string} file
 * @returns {Generator<{ match: SearchMatch, expanded: ExpandedSection | undefined, contextArrays: ContextLine[][] }>}
 */
function* matchEntriesForFile(file) {
	if (!state.currentResults) return
	for (const fileResult of state.currentResults.fileResults) {
		if (fileResult.file !== file) continue
		for (const match of fileResult.matches) {
			const expanded = expandedSections.get(match.id)
			const contextArrays = [match.contextBefore, match.contextAfter]
			if (expanded) {
				contextArrays.push(expanded.contextBefore, expanded.contextAfter)
			}
			yield { match, expanded, contextArrays }
		}
	}
}

/**
 * Text of `file`:`lineNumber` if that line is part of the rendered results
 * (as a match line or context line), else null.
 * @param {string} file
 * @param {number} lineNumber
 * @returns {string | null}
 */
export function getVisibleLineText(file, lineNumber) {
	const lineMatches = state.matchesByFileLine.get(`${file}:${lineNumber}`)
	if (lineMatches && lineMatches.length > 0) return lineMatches[0].lineText
	for (const { contextArrays } of matchEntriesForFile(file)) {
		for (const arr of contextArrays) {
			const ctx = arr.find((c) => c.line === lineNumber)
			if (ctx) return ctx.text
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
export function joinLineIntoPrevious(file, lineNumber, merged, prevLength) {
	if (!state.currentResults) return
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

	for (const { match, contextArrays } of matchEntriesForFile(file)) {
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
export function insertLineAfter(file, lineNumber, text) {
	if (!state.currentResults) return
	shiftContextTokenCache(file, lineNumber, 1)
	for (const { match, expanded, contextArrays } of matchEntriesForFile(file)) {
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
	rebuildMatchIndexes()
}

/**
 * @param {string} file
 * @param {number} lineNumber
 * @param {string} newText
 */
export function updateLineInDataModel(file, lineNumber, newText) {
	if (!state.currentResults) return
	for (const { match, contextArrays } of matchEntriesForFile(file)) {
		if (match.line === lineNumber) {
			match.lineText = newText
			match.tokens = undefined
		}
		for (const arr of contextArrays) {
			for (const ctx of arr) {
				if (ctx.line === lineNumber) {
					ctx.text = newText
					ctx.tokens = undefined
				}
			}
		}
	}
	contextTokenCache.delete(`${file}:${lineNumber}`)
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
export function storeLineTokens(file, lineNumber, text, tokens) {
	contextTokenCache.set(`${file}:${lineNumber}`, tokens)
	for (const { match, contextArrays } of matchEntriesForFile(file)) {
		if (match.line === lineNumber && match.lineText === text) {
			match.tokens = tokens
		}
		for (const arr of contextArrays) {
			for (const ctx of arr) {
				if (ctx.line === lineNumber && ctx.text === text) {
					ctx.tokens = tokens
				}
			}
		}
	}
}
