import * as vscode from 'vscode';
import { SearchQuery } from '../../search/types';
import { MARKER } from '../fixtureConstants';

export { MARKER };

export function makeQuery(overrides: Partial<SearchQuery> = {}): SearchQuery {
	return {
		id: 'test-query',
		pattern: MARKER,
		include: '',
		exclude: '*.log',
		caseSensitive: false,
		wholeWord: false,
		useRegex: false,
		replace: '',
		...overrides,
	};
}

export async function waitForWebviewPanel(
	viewType: string,
	timeoutMs = 5000
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (hasWebviewPanel(viewType)) {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return false;
}

export function hasWebviewPanel(viewType: string): boolean {
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			if (tab.label === 'FullTab Search') {
				return true;
			}
			const input = tab.input;
			if (input instanceof vscode.TabInputWebview && input.viewType === viewType) {
				return true;
			}
		}
	}
	return false;
}
