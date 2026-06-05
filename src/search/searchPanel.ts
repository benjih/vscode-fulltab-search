import * as vscode from "vscode"
import { SyntaxTokenizer } from "../syntax/tokenizer"
import { SearchEngine } from "./searchEngine"
import type {
	ContextLine,
	ExtensionMessage,
	SearchResults,
	SearchState,
	WebviewMessage,
} from "./types"

const VIEW_TYPE = "fullTabSearch.panel"
const STATE_KEY = "fullTabSearch.state"

export class SearchPanel {
	private static currentPanel: SearchPanel | undefined
	private readonly panel: vscode.WebviewPanel
	private readonly engine = new SearchEngine()
	private readonly tokenizer: SyntaxTokenizer
	private searchTokenSource: vscode.CancellationTokenSource | null = null
	private lastState: SearchState | null = null

	private constructor(
		panel: vscode.WebviewPanel,
		private readonly extensionUri: vscode.Uri,
		private readonly globalState: vscode.Memento,
		disposables: vscode.Disposable[],
	) {
		this.panel = panel
		this.lastState = globalState.get<SearchState | null>(STATE_KEY, null)
		this.tokenizer = new SyntaxTokenizer(extensionUri, disposables)

		this.panel.webview.html = this.getHtml()
		this.panel.webview.onDidReceiveMessage(
			(message) => void this.handleMessage(message as WebviewMessage),
			undefined,
			disposables,
		)
		this.panel.onDidDispose(
			() => {
				SearchPanel.currentPanel = undefined
				this.cancelSearch()
			},
			null,
			disposables,
		)
	}

	static show(context: vscode.ExtensionContext): void {
		if (SearchPanel.currentPanel) {
			SearchPanel.currentPanel.panel.reveal(vscode.ViewColumn.One)
			return
		}

		const panel = vscode.window.createWebviewPanel(
			VIEW_TYPE,
			"FullTab Search",
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [
					vscode.Uri.joinPath(context.extensionUri, "media"),
					vscode.Uri.joinPath(
						context.extensionUri,
						"node_modules",
						"@vscode",
						"codicons",
						"dist",
					),
				],
			},
		)

		SearchPanel.currentPanel = new SearchPanel(
			panel,
			context.extensionUri,
			context.globalState,
			context.subscriptions,
		)
	}

	private postMessage(message: ExtensionMessage): void {
		void this.panel.webview.postMessage(message)
	}

	private async handleMessage(message: WebviewMessage): Promise<void> {
		switch (message.type) {
			case "ready":
				this.postMessage({
					type: "init",
					state: this.lastState,
				})
				break
			case "search":
				await this.runSearch(message.state)
				break
			case "cancel":
				this.cancelSearch()
				break
			case "openMatch":
				await this.openMatch(message.file, message.line, message.column)
				break
			case "replaceMatch":
				await this.replaceMatch(
					message.file,
					message.line,
					message.column,
					message.length,
					message.replacement,
				)
				break
			case "replaceAll":
				await this.runReplaceAll(message.state)
				break
			case "expandMatch":
				await this.expandMatch(
					message.matchId,
					message.file,
					message.direction,
					message.anchorLine,
					message.count,
				)
				break
		}
	}

	private async expandMatch(
		matchId: number,
		file: string,
		direction: "before" | "after",
		anchorLine: number,
		count: number,
	): Promise<void> {
		try {
			const { lines, hasMore } = this.engine.expandContext(
				file,
				direction,
				anchorLine,
				count,
			)
			const tokenSpans = await this.tokenizer.tokenizeLines(
				lines.map((l) => l.text),
				file,
			)
			const tokenizedLines: ContextLine[] = lines.map((l, i) => ({
				...l,
				tokens: tokenSpans[i],
			}))
			this.postMessage({
				type: "expanded",
				matchId,
				direction,
				lines: tokenizedLines,
				hasMore,
			})
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Failed to load context"
			this.postMessage({ type: "error", message })
		}
	}

	private async runSearch(state: SearchState): Promise<void> {
		this.persistState(state)
		this.cancelSearch()
		this.searchTokenSource = new vscode.CancellationTokenSource()
		this.postMessage({ type: "searching" })

		try {
			const results = await this.engine.search(
				{
					id: `search-${Date.now()}`,
					pattern: state.pattern,
					include: state.include,
					exclude: state.exclude,
					caseSensitive: state.caseSensitive,
					wholeWord: state.wholeWord,
					useRegex: state.useRegex,
					replace: state.replace,
				},
				this.searchTokenSource.token,
			)

			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
			if (workspaceRoot) {
				for (const fileResult of results.fileResults) {
					fileResult.relativePath = vscode.workspace.asRelativePath(
						fileResult.file,
					)
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

			await this.attachTokens(results)
			this.postMessage({ type: "results", results })
		} catch (error) {
			const message = error instanceof Error ? error.message : "Search failed"
			this.postMessage({ type: "error", message })
		}
	}

	private async attachTokens(results: SearchResults): Promise<void> {
		for (const fileResult of results.fileResults) {
			const lineMap = new Map<number, string>()
			for (const match of fileResult.matches) {
				for (const ctx of match.contextBefore) lineMap.set(ctx.line, ctx.text)
				lineMap.set(match.line, match.lineText)
				for (const ctx of match.contextAfter) lineMap.set(ctx.line, ctx.text)
			}

			// Ripgrep line numbers are 1-indexed; tokenizer uses 0-indexed file positions.
			const sortedEntries = [...lineMap.entries()].sort(([a], [b]) => a - b)

			// Split into contiguous groups so each group gets its own grammar state
			// built from the actual file (not from a preceding group at a different depth).
			const groups: Array<{ startLine: number; lines: string[] }> = []
			let groupStart = 0
			for (let i = 1; i <= sortedEntries.length; i++) {
				const isEnd = i === sortedEntries.length
				const hasGap =
					!isEnd && sortedEntries[i][0] > sortedEntries[i - 1][0] + 1
				if (isEnd || hasGap) {
					const slice = sortedEntries.slice(groupStart, i)
					groups.push({
						startLine: slice[0][0] - 1, // convert to 0-indexed
						lines: slice.map(([, text]) => text),
					})
					groupStart = i
				}
			}

			// tokenizeFileGroups keys results by 0-indexed line number
			const tokensByLine = await this.tokenizer.tokenizeFileGroups(
				groups,
				fileResult.file,
			)

			for (const match of fileResult.matches) {
				match.tokens = tokensByLine.get(match.line - 1)
				for (const ctx of match.contextBefore) {
					ctx.tokens = tokensByLine.get(ctx.line - 1)
				}
				for (const ctx of match.contextAfter) {
					ctx.tokens = tokensByLine.get(ctx.line - 1)
				}
			}
		}
	}

	private async runReplaceAll(state: SearchState): Promise<void> {
		this.persistState(state)
		this.cancelSearch()
		this.searchTokenSource = new vscode.CancellationTokenSource()

		try {
			const count = await this.engine.replaceAll(
				{
					id: `replace-${Date.now()}`,
					pattern: state.pattern,
					include: state.include,
					exclude: state.exclude,
					caseSensitive: state.caseSensitive,
					wholeWord: state.wholeWord,
					useRegex: state.useRegex,
					replace: state.replace,
				},
				this.searchTokenSource.token,
			)
			this.postMessage({ type: "replaced", count })
			await this.runSearch(state)
		} catch (error) {
			const message = error instanceof Error ? error.message : "Replace failed"
			this.postMessage({ type: "error", message })
		}
	}

	private async openMatch(
		file: string,
		line: number,
		column: number,
	): Promise<void> {
		const uri = vscode.Uri.file(file)
		const document = await vscode.workspace.openTextDocument(uri)
		const editor = await vscode.window.showTextDocument(document, {
			preview: false,
			preserveFocus: false,
		})

		const position = new vscode.Position(line - 1, column)
		editor.selection = new vscode.Selection(position, position)
		editor.revealRange(
			new vscode.Range(position, position),
			vscode.TextEditorRevealType.InCenter,
		)
	}

	private async replaceMatch(
		file: string,
		line: number,
		column: number,
		length: number,
		replacement: string,
	): Promise<void> {
		const uri = vscode.Uri.file(file)
		const edit = new vscode.WorkspaceEdit()
		edit.replace(
			uri,
			new vscode.Range(line - 1, column, line - 1, column + length),
			replacement,
		)
		await vscode.workspace.applyEdit(edit)
		this.postMessage({ type: "replaced", count: 1 })
	}

	private persistState(state: SearchState): void {
		this.lastState = state
		void this.globalState.update(STATE_KEY, state)
	}

	private cancelSearch(): void {
		this.engine.cancel()
		this.searchTokenSource?.cancel()
		this.searchTokenSource?.dispose()
		this.searchTokenSource = null
	}

	private getHtml(): string {
		const webview = this.panel.webview
		const styleUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "media", "search.css"),
		)
		const codiconsUri = webview.asWebviewUri(
			vscode.Uri.joinPath(
				this.extensionUri,
				"node_modules",
				"@vscode",
				"codicons",
				"dist",
				"codicon.css",
			),
		)
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "media", "search.js"),
		)
		const nonce = getNonce()

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${styleUri}" rel="stylesheet">
	<link href="${codiconsUri}" rel="stylesheet">
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
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
	}
}

function getNonce(): string {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	let nonce = ""
	for (let i = 0; i < 32; i++) {
		nonce += chars.charAt(Math.floor(Math.random() * chars.length))
	}
	return nonce
}
