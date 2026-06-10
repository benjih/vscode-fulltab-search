import * as vscode from "vscode"
import type { FileIconResolver } from "./fileIconResolver"
import type { SearchResults } from "./types"

// Annotates engine results in place with workspace-relative paths, file icons,
// and stable match ids before they are sent to the webview.
export function enrichResults(
	results: SearchResults,
	iconResolver: FileIconResolver,
	webview: vscode.Webview,
): void {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
	if (workspaceRoot) {
		for (const fileResult of results.fileResults) {
			fileResult.relativePath = vscode.workspace.asRelativePath(fileResult.file)
			fileResult.directory = fileResult.relativePath.includes("/")
				? fileResult.relativePath.slice(
						0,
						fileResult.relativePath.lastIndexOf("/"),
					)
				: ""
			fileResult.fileName =
				fileResult.relativePath.split("/").pop() ?? fileResult.fileName
			for (const match of fileResult.matches) {
				match.relativePath = fileResult.relativePath
			}
		}
	}
	results.fileResults.sort((a, b) =>
		a.relativePath.localeCompare(b.relativePath),
	)
	for (const fileResult of results.fileResults) {
		const uri = iconResolver.resolveWebviewUri(fileResult.fileName, webview)
		if (uri) {
			fileResult.iconUri = uri
		} else {
			const font = iconResolver.resolveIconFont(fileResult.fileName)
			if (font) fileResult.iconFont = font
		}
	}
	let idCounter = 0
	for (const fileResult of results.fileResults) {
		for (const match of fileResult.matches) {
			match.id = idCounter++
		}
	}
}
