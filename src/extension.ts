import * as vscode from "vscode"
import {
	clearRecordedMetrics,
	getRecordedMetrics,
	initDebugOutput,
} from "./debug/metrics"
import { SearchPanel } from "./search/searchPanel"

export function activate(context: vscode.ExtensionContext) {
	initDebugOutput(context)
	const openSearch = vscode.commands.registerCommand(
		"fullTabSearch.open",
		() => {
			SearchPanel.show(context)
		},
	)
	const getDebugMetrics = vscode.commands.registerCommand(
		"fullTabSearch.getDebugMetrics",
		() => getRecordedMetrics(),
	)
	const clearDebugMetrics = vscode.commands.registerCommand(
		"fullTabSearch.clearDebugMetrics",
		() => {
			clearRecordedMetrics()
		},
	)

	const openAndCloseSidebar = () => {
		SearchPanel.show(context)
		void vscode.commands.executeCommand("workbench.action.closeSidebar")
	}
	const activityViewProvider: vscode.WebviewViewProvider = {
		resolveWebviewView(view) {
			openAndCloseSidebar()
			view.onDidChangeVisibility(() => {
				if (view.visible) {
					openAndCloseSidebar()
				}
			})
		},
	}
	const activityView = vscode.window.registerWebviewViewProvider(
		"fullTabSearch.activityView",
		activityViewProvider,
	)

	context.subscriptions.push(openSearch, getDebugMetrics, clearDebugMetrics, activityView)
}

export function deactivate() {}
