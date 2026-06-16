// @ts-check
/// <reference lib="dom" />

// HTML-string rendering of a single line: escaping, syntax token spans, and
// match-highlight ranges.

import { state } from "./model.js"

/** @typedef {import("./types.js").TokenSpan} TokenSpan */
/** @typedef {import("./types.js").SearchMatch} SearchMatch */

export function escapeHtml(value) {
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
export function renderTokenSpans(spans) {
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
 * @param {Array<{ start: number; end: number; active: boolean; id?: number }>} ranges
 * @param {TokenSpan[] | undefined} [tokens]
 */
export function renderLineContent(line, ranges, tokens) {
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
		const idAttr = range.id == null ? "" : ` data-match-id="${range.id}"`
		html += renderSlice(pos, range.start)
		html += `<span class="${highlightClass}"${idAttr}>${renderSlice(range.start, range.end)}</span>`
		pos = range.end
	}
	html += renderSlice(pos, line.length)
	return html
}

/** @param {SearchMatch[]} lineMatches */
export function matchHighlightRanges(lineMatches) {
	return lineMatches.map((m) => ({
		start: m.matchStart,
		end: m.matchEnd,
		active: m.id === state.activeMatchIndex,
		id: m.id,
	}))
}
