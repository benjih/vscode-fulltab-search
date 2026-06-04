import * as vscode from 'vscode';
import { SearchPanel } from './search/searchPanel';

export function activate(context: vscode.ExtensionContext) {
	const openSearch = vscode.commands.registerCommand('fullTabSearch.open', () => {
		SearchPanel.show(context);
	});

	context.subscriptions.push(openSearch);
}

export function deactivate() {}
