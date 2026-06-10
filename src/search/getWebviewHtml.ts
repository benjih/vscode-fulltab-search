import { randomBytes } from "node:crypto"
import * as vscode from "vscode"

export function getWebviewHtml(
	webview: vscode.Webview,
	extensionUri: vscode.Uri,
	fontFaceCss: string | null = null,
): string {
	const styleUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, "media", "search.css"),
	)
	const codiconsUri = webview.asWebviewUri(
		vscode.Uri.joinPath(
			extensionUri,
			"node_modules",
			"@vscode",
			"codicons",
			"dist",
			"codicon.css",
		),
	)
	const scriptUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, "media", "search.js"),
	)
	const nonce = randomBytes(16).toString("hex")

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${styleUri}" rel="stylesheet">
	<link href="${codiconsUri}" rel="stylesheet">
	${fontFaceCss ? `<style>${fontFaceCss}</style>` : ""}
	<title>FullTab Search</title>
</head>
<body>
	<div class="search-shell">
		<div class="search-controls">
			<div class="search-row">
				<input id="patternInput" class="search-input" type="text" placeholder="Search" spellcheck="false" />
				<div class="toggle-group">
					<button id="caseToggle" class="toggle" title="Match Case">Aa</button>
					<button id="wordToggle" class="toggle" title="Match Whole Word">ab</button>
					<button id="regexToggle" class="toggle" title="Use Regular Expression">.*</button>
				</div>
				<div class="nav-group">
					<button id="prevMatch" class="icon-button" title="Previous Match">‹</button>
					<span id="matchCounter" class="match-counter">0/0</span>
					<button id="nextMatch" class="icon-button" title="Next Match">›</button>
				</div>
				<button id="editToggle" class="toggle" title="Toggle edit mode"><span class="codicon codicon-edit"></span></button>
			</div>

			<div class="filter-row">
				<div class="filter-field">
					<span class="filter-label">Include:</span>
					<input id="includeInput" class="filter-input" type="text" placeholder="*.*" spellcheck="false" />
				</div>
				<div class="filter-field">
					<span class="filter-label">Exclude:</span>
					<input id="excludeInput" class="filter-input" type="text" placeholder="node_modules/**, *.lock" spellcheck="false" />
				</div>
				<div class="replace-actions">
					<input id="replaceInput" class="replace-input" type="text" placeholder="Replace" spellcheck="false" />
					<button id="replaceOne" class="action-button" title="Replace">Replace</button>
					<button id="replaceAll" class="action-button" title="Replace All">All</button>
				</div>
			</div>
		</div>

		<div id="statusBar" class="status-bar"></div>
		<div id="results" class="results"></div>
	</div>
	<script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
}
