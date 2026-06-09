// @ts-check
/// <reference lib="dom" />

// Caret and selection utilities for contenteditable lines, all in terms of
// plain character offsets so callers never deal with text nodes directly.

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
export function getCaretOffset(el) {
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
export function getSelectionOffsets(el) {
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
export function setCaretOffset(el, offset) {
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
