// @ts-check
/// <reference lib="dom" />

// Asynchronous tokenization plumbing: debounced live re-tokenization of
// lines being edited. Responses arrive as messages handled by the entry
// module. (Context-line tokens are pushed eagerly by the host alongside
// search results; see tokenizeResultsAsync in searchPanel.ts.)

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
