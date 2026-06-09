// @ts-check
/// <reference lib="dom" />

// Panel chrome: lookups for the static toolbar/status elements rendered by
// SearchPanel.getHtml(), plus the helpers that sync them with the model.

import { vscode } from "./ipc.js"
import { state } from "./model.js"

export const patternInput = /** @type {HTMLInputElement} */ (
	document.getElementById("patternInput")
)
export const includeInput = /** @type {HTMLInputElement} */ (
	document.getElementById("includeInput")
)
export const excludeInput = /** @type {HTMLInputElement} */ (
	document.getElementById("excludeInput")
)
export const replaceInput = /** @type {HTMLInputElement} */ (
	document.getElementById("replaceInput")
)
export const caseToggle = /** @type {HTMLButtonElement} */ (
	document.getElementById("caseToggle")
)
export const wordToggle = /** @type {HTMLButtonElement} */ (
	document.getElementById("wordToggle")
)
export const regexToggle = /** @type {HTMLButtonElement} */ (
	document.getElementById("regexToggle")
)
export const prevMatch = /** @type {HTMLButtonElement} */ (
	document.getElementById("prevMatch")
)
export const nextMatch = /** @type {HTMLButtonElement} */ (
	document.getElementById("nextMatch")
)
export const matchCounter = /** @type {HTMLElement} */ (
	document.getElementById("matchCounter")
)
export const statusBar = /** @type {HTMLElement} */ (
	document.getElementById("statusBar")
)
export const resultsEl = /** @type {HTMLElement} */ (
	document.getElementById("results")
)
export const replaceOne = /** @type {HTMLButtonElement} */ (
	document.getElementById("replaceOne")
)
export const replaceAllBtn = /** @type {HTMLButtonElement} */ (
	document.getElementById("replaceAll")
)
export const editToggle = /** @type {HTMLButtonElement} */ (
	document.getElementById("editToggle")
)

export function syncInputsFromState() {
	patternInput.value = state.searchState.pattern
	includeInput.value = state.searchState.include
	excludeInput.value = state.searchState.exclude
	replaceInput.value = state.searchState.replace
	caseToggle.classList.toggle("active", state.searchState.caseSensitive)
	wordToggle.classList.toggle("active", state.searchState.wholeWord)
	regexToggle.classList.toggle("active", state.searchState.useRegex)
}

export function syncStateFromInputs() {
	state.searchState.pattern = patternInput.value
	state.searchState.include = includeInput.value
	state.searchState.exclude = excludeInput.value
	state.searchState.replace = replaceInput.value
	state.searchState.caseSensitive = caseToggle.classList.contains("active")
	state.searchState.wholeWord = wordToggle.classList.contains("active")
	state.searchState.useRegex = regexToggle.classList.contains("active")
}

export function scheduleSearch() {
	syncStateFromInputs()
	vscode.postMessage({ type: "search", state: state.searchState })
}

export function setStatus(text) {
	statusBar.textContent = text
}

export function updateMatchCounter() {
	const total = state.currentResults?.total ?? 0
	if (total === 0) {
		matchCounter.textContent = "0/0"
		return
	}

	matchCounter.textContent = `${state.activeMatchIndex + 1}/${total}`
}
