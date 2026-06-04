// @ts-check
/// <reference lib="dom" />

/** @typedef {{ id: string; pattern: string; include: string; exclude: string; caseSensitive: boolean; wholeWord: boolean; useRegex: boolean; replace: string }} SearchTab */
/** @typedef {{ id: number; file: string; relativePath: string; line: number; column: number; lineText: string; matchStart: number; matchEnd: number; contextBefore: string[]; contextAfter: string[]; breadcrumb: string }} SearchMatch */
/** @typedef {{ file: string; relativePath: string; directory: string; fileName: string; matches: SearchMatch[] }} FileResult */
/** @typedef {{ queryId: string; fileResults: FileResult[]; total: number; truncated: boolean }} SearchResults */

/** @type {import('vscode') | undefined} */
const vscode = acquireVsCodeApi();

/** @type {SearchTab[]} */
let tabs = [];
/** @type {string | null} */
let activeTabId = null;
/** @type {SearchResults | null} */
let currentResults = null;
/** @type {number} */
let activeMatchIndex = 0;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let searchDebounce;

const tabBar = /** @type {HTMLElement} */ (document.getElementById('tabBar'));
const patternInput = /** @type {HTMLInputElement} */ (document.getElementById('patternInput'));
const includeInput = /** @type {HTMLInputElement} */ (document.getElementById('includeInput'));
const excludeInput = /** @type {HTMLInputElement} */ (document.getElementById('excludeInput'));
const replaceInput = /** @type {HTMLInputElement} */ (document.getElementById('replaceInput'));
const caseToggle = /** @type {HTMLButtonElement} */ (document.getElementById('caseToggle'));
const wordToggle = /** @type {HTMLButtonElement} */ (document.getElementById('wordToggle'));
const regexToggle = /** @type {HTMLButtonElement} */ (document.getElementById('regexToggle'));
const prevMatch = /** @type {HTMLButtonElement} */ (document.getElementById('prevMatch'));
const nextMatch = /** @type {HTMLButtonElement} */ (document.getElementById('nextMatch'));
const matchCounter = /** @type {HTMLElement} */ (document.getElementById('matchCounter'));
const statusBar = /** @type {HTMLElement} */ (document.getElementById('statusBar'));
const resultsEl = /** @type {HTMLElement} */ (document.getElementById('results'));
const replaceOne = /** @type {HTMLButtonElement} */ (document.getElementById('replaceOne'));
const replaceAllBtn = /** @type {HTMLButtonElement} */ (document.getElementById('replaceAll'));

function createTabId() {
	return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** @returns {SearchTab} */
function createEmptyTab() {
	return {
		id: createTabId(),
		pattern: '',
		include: '',
		exclude: 'node_modules/**, *.lock',
		caseSensitive: false,
		wholeWord: false,
		useRegex: false,
		replace: '',
	};
}

/** @returns {SearchTab} */
function getActiveTab() {
	const existing = tabs.find((tab) => tab.id === activeTabId);
	if (existing) {
		return existing;
	}

	const tab = createEmptyTab();
	tabs = [tab, ...tabs];
	activeTabId = tab.id;
	return tab;
}

function syncInputsFromTab() {
	const tab = getActiveTab();
	patternInput.value = tab.pattern;
	includeInput.value = tab.include;
	excludeInput.value = tab.exclude;
	replaceInput.value = tab.replace;
	caseToggle.classList.toggle('active', tab.caseSensitive);
	wordToggle.classList.toggle('active', tab.wholeWord);
	regexToggle.classList.toggle('active', tab.useRegex);
	renderTabs();
}

function syncTabFromInputs() {
	const tab = getActiveTab();
	tab.pattern = patternInput.value;
	tab.include = includeInput.value;
	tab.exclude = excludeInput.value;
	tab.replace = replaceInput.value;
	tab.caseSensitive = caseToggle.classList.contains('active');
	tab.wholeWord = wordToggle.classList.contains('active');
	tab.useRegex = regexToggle.classList.contains('active');
	renderTabs();
}

function renderTabs() {
	tabBar.innerHTML = '';

	for (const tab of tabs) {
		const button = document.createElement('button');
		button.className = `tab${tab.id === activeTabId ? ' active' : ''}`;
		button.title = tab.pattern || 'New search';

		const label = document.createElement('span');
		label.className = 'tab-label';
		label.textContent = tab.pattern || 'New search';
		button.appendChild(label);

		button.addEventListener('click', () => {
			syncTabFromInputs();
			activeTabId = tab.id;
			syncInputsFromTab();
			scheduleSearch();
		});

		tabBar.appendChild(button);
	}

	const addButton = document.createElement('button');
	addButton.className = 'tab-add';
	addButton.textContent = '+';
	addButton.title = 'New search tab';
	addButton.addEventListener('click', () => {
		syncTabFromInputs();
		const tab = createEmptyTab();
		tabs = [tab, ...tabs].slice(0, 12);
		activeTabId = tab.id;
		currentResults = null;
		activeMatchIndex = 0;
		syncInputsFromTab();
		renderResults();
		updateMatchCounter();
		setStatus('New search tab');
		patternInput.focus();
	});
	tabBar.appendChild(addButton);
}

function scheduleSearch() {
	syncTabFromInputs();
	clearTimeout(searchDebounce);
	searchDebounce = setTimeout(() => {
		const tab = getActiveTab();
		vscode.postMessage({ type: 'search', tab });
	}, 250);
}

function setStatus(text) {
	statusBar.textContent = text;
}

function updateMatchCounter() {
	const total = currentResults?.total ?? 0;
	if (total === 0) {
		matchCounter.textContent = '0/0';
		return;
	}

	matchCounter.textContent = `${activeMatchIndex + 1}/${total}`;
}

/** @returns {SearchMatch[]} */
function flattenMatches() {
	if (!currentResults) {
		return [];
	}

	return currentResults.fileResults.flatMap((file) => file.matches);
}

function focusMatch(index) {
	const matches = flattenMatches();
	if (matches.length === 0) {
		activeMatchIndex = 0;
		updateMatchCounter();
		return;
	}

	activeMatchIndex = ((index % matches.length) + matches.length) % matches.length;
	updateMatchCounter();
	renderResults();

	const activeEl = document.querySelector('.snippet-line.active');
	if (activeEl) {
		activeEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
	}
}

function escapeHtml(value) {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** @param {string} line @param {number} start @param {number} end @param {boolean} isActive */
function renderLineContent(line, start, end, isActive) {
	const before = escapeHtml(line.slice(0, start));
	const match = escapeHtml(line.slice(start, end));
	const after = escapeHtml(line.slice(end));
	const highlightClass = isActive ? 'match-highlight' : 'match-highlight';
	return `${before}<span class="${highlightClass}">${match}</span>${after}`;
}

/** @param {SearchMatch} match @param {boolean} isActive */
function renderMatchBlock(match, isActive) {
	const block = document.createElement('div');
	block.className = 'match-block';
	block.dataset.matchId = String(match.id);

	const lines = [];

	for (const contextLine of match.contextBefore) {
		lines.push({ lineNumber: null, text: contextLine, isMatch: false, isActive: false });
	}

	lines.push({
		lineNumber: match.line,
		text: match.lineText,
		isMatch: true,
		isActive,
	});

	for (const contextLine of match.contextAfter) {
		lines.push({ lineNumber: null, text: contextLine, isMatch: false, isActive: false });
	}

	const snippet = document.createElement('div');
	snippet.className = 'snippet';

	for (const entry of lines) {
		const row = document.createElement('div');
		row.className = `snippet-line${entry.isMatch && isActive ? ' active' : ''}`;

		const lineNumber = document.createElement('span');
		lineNumber.className = 'line-number';
		lineNumber.textContent = entry.lineNumber ? String(entry.lineNumber) : '';

		const content = document.createElement('span');
		content.className = 'line-content';
		if (entry.isMatch) {
			content.innerHTML = renderLineContent(entry.text, match.matchStart, match.matchEnd, isActive);
		} else {
			content.textContent = entry.text;
		}

		row.appendChild(lineNumber);
		row.appendChild(content);

		if (entry.isMatch) {
			row.addEventListener('click', () => {
				activeMatchIndex = match.id;
				updateMatchCounter();
				renderResults();
				vscode.postMessage({
					type: 'openMatch',
					file: match.file,
					line: match.line,
					column: match.column,
				});
			});
		}

		snippet.appendChild(row);
	}

	block.appendChild(snippet);

	if (match.breadcrumb) {
		const meta = document.createElement('div');
		meta.className = 'match-meta';
		meta.textContent = match.breadcrumb;
		block.appendChild(meta);
	}

	return block;
}

function renderResults() {
	resultsEl.innerHTML = '';

	if (!currentResults || currentResults.total === 0) {
		const empty = document.createElement('div');
		empty.className = 'empty-state';
		empty.textContent = patternInput.value.trim()
			? 'No results found'
			: 'Enter a search query to search across your workspace';
		resultsEl.appendChild(empty);
		return;
	}

	for (const fileResult of currentResults.fileResults) {
		const group = document.createElement('section');
		group.className = 'file-group';

		const header = document.createElement('div');
		header.className = 'file-header';

		const icon = document.createElement('span');
		icon.className = 'file-icon';
		icon.textContent = '📄';

		const name = document.createElement('span');
		name.className = 'file-name';
		name.textContent = fileResult.fileName;

		const path = document.createElement('span');
		path.className = 'file-path';
		path.textContent = fileResult.directory ? `${fileResult.directory}/` : '';

		const breadcrumb = document.createElement('span');
		breadcrumb.className = 'file-breadcrumb';
		breadcrumb.textContent = fileResult.matches[0]?.breadcrumb ?? '';

		const openButton = document.createElement('button');
		openButton.className = 'open-file';
		openButton.textContent = 'Open File';
		openButton.addEventListener('click', () => {
			const firstMatch = fileResult.matches[0];
			if (firstMatch) {
				vscode.postMessage({
					type: 'openMatch',
					file: firstMatch.file,
					line: firstMatch.line,
					column: firstMatch.column,
				});
			}
		});

		header.appendChild(icon);
		header.appendChild(name);
		header.appendChild(path);
		header.appendChild(breadcrumb);
		header.appendChild(openButton);
		group.appendChild(header);

		for (const match of fileResult.matches) {
			group.appendChild(renderMatchBlock(match, match.id === activeMatchIndex));
		}

		resultsEl.appendChild(group);
	}
}

patternInput.addEventListener('input', scheduleSearch);
includeInput.addEventListener('input', scheduleSearch);
excludeInput.addEventListener('input', scheduleSearch);

replaceInput.addEventListener('input', syncTabFromInputs);

for (const toggle of [caseToggle, wordToggle, regexToggle]) {
	toggle.addEventListener('click', () => {
		toggle.classList.toggle('active');
		scheduleSearch();
	});
}

prevMatch.addEventListener('click', () => focusMatch(activeMatchIndex - 1));
nextMatch.addEventListener('click', () => focusMatch(activeMatchIndex + 1));

replaceOne.addEventListener('click', () => {
	const matches = flattenMatches();
	const match = matches[activeMatchIndex];
	const tab = getActiveTab();
	if (!match) {
		return;
	}

	vscode.postMessage({
		type: 'replaceMatch',
		file: match.file,
		line: match.line,
		column: match.matchStart,
		length: match.matchEnd - match.matchStart,
		replacement: tab.replace,
	});
});

replaceAllBtn.addEventListener('click', () => {
	syncTabFromInputs();
	vscode.postMessage({ type: 'replaceAll', tab: getActiveTab() });
});

document.addEventListener('keydown', (event) => {
	if (event.key === 'Enter' && document.activeElement === patternInput) {
		clearTimeout(searchDebounce);
		syncTabFromInputs();
		vscode.postMessage({ type: 'search', tab: getActiveTab() });
	}

	if (event.key === 'F4' || (event.key === 'g' && event.ctrlKey)) {
		event.preventDefault();
		focusMatch(activeMatchIndex + (event.shiftKey ? -1 : 1));
	}
});

window.addEventListener('message', (event) => {
	const message = event.data;

	switch (message.type) {
		case 'init':
			tabs = message.tabs?.length ? message.tabs : [createEmptyTab()];
			activeTabId = message.activeTabId ?? tabs[0].id;
			syncInputsFromTab();
			if (getActiveTab().pattern.trim()) {
				scheduleSearch();
			} else {
				renderResults();
				updateMatchCounter();
			}
			break;
		case 'searching':
			setStatus('Searching…');
			break;
		case 'results':
			currentResults = message.results;
			activeMatchIndex = 0;
			renderResults();
			updateMatchCounter();
			setStatus(
				message.results.truncated
					? `${message.results.total}+ results (truncated)`
					: `${message.results.total} result${message.results.total === 1 ? '' : 's'} in ${message.results.fileResults.length} file${message.results.fileResults.length === 1 ? '' : 's'}`
			);
			break;
		case 'error':
			setStatus(message.message);
			break;
		case 'replaced':
			setStatus(`Replaced ${message.count} occurrence${message.count === 1 ? '' : 's'}`);
			scheduleSearch();
			break;
	}
});

vscode.postMessage({ type: 'ready' });
