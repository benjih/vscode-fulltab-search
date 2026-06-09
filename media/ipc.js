// @ts-check
/// <reference lib="dom" />

// All communication with the extension host (searching, opening files,
// replacing text) goes through the postMessage / onDidReceiveMessage IPC
// bridge that VS Code provides for webviews.
//
// acquireVsCodeApi() is injected by the webview runtime and must be called
// exactly once, so every module shares this instance.
export const vscode = /** @type {{ postMessage(message: unknown): void }} */ (
	/** @type {unknown} */ (acquireVsCodeApi())
)
