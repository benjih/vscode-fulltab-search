// @ts-check
/// <reference lib="dom" />

// Asynchronous tokenization plumbing: lazy syntax highlighting for context
// lines (requested when a match block scrolls near the viewport) and
// debounced live re-tokenization of lines being edited. Responses arrive as
// messages handled by the entry module.

import { vscode } from "./ipc.js"

const LIVE_TOKENIZE_DEBOUNCE_MS = 120

/** @type {Map<string, ReturnType<typeof setTimeout>>} keyed by "file:lineNumber" */
const liveTokenizeTimers = new Map()

/**
 * @param {HTMLElement} content
 * @param {string} file
 * @param {number} lineNumber
 */
export function requestLineTokens(content, file, lineNumber) {
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
export function scheduleLineTokens(content, file, lineNumber) {
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
export function cancelScheduledLineTokens(file, lineNumber) {
	const key = `${file}:${lineNumber}`
	const pending = liveTokenizeTimers.get(key)
	if (pending !== undefined) {
		clearTimeout(pending)
		liveTokenizeTimers.delete(key)
	}
}

/** @typedef {{ file: string; lines: Array<{line: number; text: string}>; firstMatchId: number }} BlockContextMeta */

/** @type {Set<number>} first-match IDs of sections that have already been requested */
const contextTokenRequested = new Set()
/** @type {WeakMap<Element, BlockContextMeta>} */
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

/**
 * Registers a rendered match block so its context lines are tokenized lazily
 * once the block scrolls near the viewport.
 * @param {Element} block
 * @param {BlockContextMeta} meta
 */
export function observeBlockContext(block, meta) {
	blockContextMeta.set(block, meta)
	contextObserver.observe(block)
}

// Called before a full re-render replaces the observed blocks.
export function disconnectContextObserver() {
	contextObserver.disconnect()
}

// Called when a new result set arrives and old match IDs become meaningless.
export function clearContextTokenRequests() {
	contextTokenRequested.clear()
}
