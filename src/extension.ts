import * as vscode from "vscode"
import { initDebugOutput } from "./debug/metrics"
import { SearchPanel } from "./search/searchPanel"

export function activate(context: vscode.ExtensionContext) {
	initDebugOutput(context)
	const openSearch = vscode.commands.registerCommand(
		"fullTabSearch.open",
		() => {
			SearchPanel.show(context)
		},
	)

	context.subscriptions.push(openSearch)
}

export function deactivate() {}
