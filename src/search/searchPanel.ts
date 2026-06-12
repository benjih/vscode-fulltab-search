import * as vscode from "vscode"
import { createTimer, searchQueryDetails } from "../debug/metrics"
import { SyntaxTokenizer } from "../syntax/tokenizer"
import { enrichResults } from "./enrichResults"
import { FileIconResolver } from "./fileIconResolver"
import { getWebviewHtml } from "./getWebviewHtml"
import { applyLineEdit, applyLineJoin, applyLineSplit } from "./lineEdits"
import { SearchEngine, saveEditedDocuments } from "./searchEngine"
import type {
	ContextLine,
	ExtensionMessage,
	SearchResults,
	SearchState,
	TokenSpan,
	WebviewMessage,
} from "./types"

const VIEW_TYPE = "fullTabSearch.panel"
const STATE_KEY = "fullTabSearch.state"

export class SearchPanel {
	private static currentPanel: SearchPanel | undefined
	private readonly panel: vscode.WebviewPanel
	private readonly engine = new SearchEngine()
	private readonly tokenizer: SyntaxTokenizer
	private queryCounter = 0
	private tokenizationQueryId: string | null = null
	// Files with edits applied to their (dirty) documents but not yet saved.
	private readonly pendingEditUris = new Map<string, vscode.Uri>()
	private searchTokenSource: vscode.CancellationTokenSource | null = null

	private constructor(
		panel: vscode.WebviewPanel,
		private readonly extensionUri: vscode.Uri,
		private readonly globalState: vscode.Memento,
		disposables: vscode.Disposable[],
		private readonly iconResolver: FileIconResolver,
	) {
		this.panel = panel
		this.tokenizer = new SyntaxTokenizer(extensionUri, disposables)

		const fontFaceCss = iconResolver.generateFontFaceCss(this.panel.webview)
		this.panel.webview.html = getWebviewHtml(
			this.panel.webview,
			extensionUri,
			fontFaceCss,
		)
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

	static async show(context: vscode.ExtensionContext): Promise<void> {
		if (SearchPanel.currentPanel) {
			SearchPanel.currentPanel.panel.reveal(vscode.ViewColumn.One)
			return
		}

		const iconResolver = new FileIconResolver()
		await iconResolver.load()

		const localResourceRoots = [
			vscode.Uri.joinPath(context.extensionUri, "media"),
			vscode.Uri.joinPath(
				context.extensionUri,
				"node_modules",
				"@vscode",
				"codicons",
				"dist",
			),
		]
		const iconRoot = iconResolver.getLocalResourceRoot()
		if (iconRoot) localResourceRoots.push(iconRoot)

		const panel = vscode.window.createWebviewPanel(
			VIEW_TYPE,
			"FullTab Search",
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots,
			},
		)

		SearchPanel.currentPanel = new SearchPanel(
			panel,
			context.extensionUri,
			context.globalState,
			context.subscriptions,
			iconResolver,
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
					state: null,
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
			case "editLine":
				await this.editLine(message.file, message.line, message.newContent)
				break
			case "splitLine":
				await this.splitLine(
					message.file,
					message.line,
					message.before,
					message.after,
				)
				break
			case "joinLines":
				await this.joinLines(message.file, message.line, message.mergedContent)
				break
			case "saveEdits":
				await this.saveEdits()
				break
			case "tokenizeLine":
				await this.tokenizeLine(message.file, message.line, message.text)
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
		const totalTimer = createTimer("expandMatch", { direction })
		try {
			const { lines, hasMore } = this.engine.expandContext(
				file,
				direction,
				anchorLine,
				count,
			)
			const tokenTimer = createTimer("expandMatch.tokenize")
			const tokenSpans = await this.tokenizer.tokenizeLines(
				lines.map((l) => l.text),
				file,
			)
			tokenTimer.end({ lines: lines.length })
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
			totalTimer.end({ lines: lines.length })
		} catch (error) {
			totalTimer.end({ error: true })
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
		const queryDetails = searchQueryDetails(state)
		const totalTimer = createTimer("runSearch", queryDetails)

		try {
			const engineTimer = createTimer("runSearch.engine", queryDetails)
			const results = await this.engine.search(
				{ id: `search-${++this.queryCounter}`, ...state },
				this.searchTokenSource.token,
			)
			engineTimer.end({
				matches: results.total,
				files: results.fileResults.length,
			})

			const enrichTimer = createTimer("runSearch.enrichPaths", queryDetails)
			enrichResults(results, this.iconResolver, this.panel.webview)
			enrichTimer.end({ files: results.fileResults.length })

			this.postMessage({ type: "results", results })
			totalTimer.end({
				matches: results.total,
				files: results.fileResults.length,
				truncated: results.truncated,
			})

			void this.tokenizeResultsAsync(results)
		} catch (error) {
			totalTimer.end({ error: true })
			const message = error instanceof Error ? error.message : "Search failed"
			this.postMessage({ type: "error", message })
		}
	}

	private async tokenizeResultsAsync(results: SearchResults): Promise<void> {
		const queryId = results.queryId
		this.tokenizationQueryId = queryId

		for (const fileResult of results.fileResults) {
			if (this.tokenizationQueryId !== queryId) return

			const lineMap = new Map<number, string>()
			for (const match of fileResult.matches) {
				for (const ctx of match.contextBefore) lineMap.set(ctx.line, ctx.text)
				lineMap.set(match.line, match.lineText)
				for (const ctx of match.contextAfter) lineMap.set(ctx.line, ctx.text)
			}

			const sortedEntries = [...lineMap.entries()].sort(([a], [b]) => a - b)

			const groups: Array<{ startLine: number; lines: string[] }> = []
			let groupStart = 0
			for (let i = 1; i <= sortedEntries.length; i++) {
				const isEnd = i === sortedEntries.length
				const hasGap =
					!isEnd && sortedEntries[i][0] > sortedEntries[i - 1][0] + 1
				if (isEnd || hasGap) {
					const slice = sortedEntries.slice(groupStart, i)
					groups.push({
						startLine: slice[0][0] - 1,
						lines: slice.map(([, text]) => text),
					})
					groupStart = i
				}
			}

			const tokensByLine = await this.tokenizer.tokenizeFileGroups(
				groups,
				fileResult.file,
			)

			if (this.tokenizationQueryId !== queryId) return

			const matchTokens = fileResult.matches.flatMap((match) => {
				const tokens = tokensByLine.get(match.line - 1)
				return tokens ? [{ matchId: match.id, tokens }] : []
			})

			const seenLines = new Set<number>()
			const contextTokensPayload: Array<{ line: number; tokens: TokenSpan[] }> =
				[]
			for (const match of fileResult.matches) {
				for (const ctx of [...match.contextBefore, ...match.contextAfter]) {
					if (seenLines.has(ctx.line)) continue
					seenLines.add(ctx.line)
					const tokens = tokensByLine.get(ctx.line - 1)
					if (tokens) contextTokensPayload.push({ line: ctx.line, tokens })
				}
			}

			if (matchTokens.length > 0) {
				this.postMessage({ type: "matchTokens", queryId, tokens: matchTokens })
			}
			if (contextTokensPayload.length > 0) {
				this.postMessage({
					type: "contextTokens",
					queryId,
					file: fileResult.file,
					tokensByLine: contextTokensPayload,
				})
			}

			// Yield to the macrotask queue so the VS Code IPC layer can deliver
			// messages to the webview before the next file starts.
			// A plain `await` only yields to microtasks, which isn't enough.
			await new Promise<void>((resolve) => setImmediate(resolve))
		}
	}

	private async runReplaceAll(state: SearchState): Promise<void> {
		this.persistState(state)
		this.cancelSearch()
		this.searchTokenSource = new vscode.CancellationTokenSource()
		const queryDetails = searchQueryDetails(state)
		const totalTimer = createTimer("runReplaceAll", queryDetails)

		try {
			const count = await this.engine.replaceAll(
				{ id: `replace-${++this.queryCounter}`, ...state },
				this.searchTokenSource.token,
			)
			this.postMessage({ type: "replaced", count })
			await this.runSearch(state)
			totalTimer.end({ replacements: count })
		} catch (error) {
			totalTimer.end({ error: true })
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
		const applied = await vscode.workspace.applyEdit(edit)
		if (!applied) {
			this.postMessage({ type: "error", message: "Replace failed" })
			return
		}
		await saveEditedDocuments([uri])
		this.postMessage({ type: "replaced", count: 1 })
	}

	// Edits are applied to the in-memory document (leaving it dirty, like
	// typing in an editor) and only written to disk by an explicit saveEdits.
	private async editLine(
		file: string,
		line: number,
		newContent: string,
	): Promise<void> {
		const uri = await applyLineEdit(file, line, newContent)
		this.pendingEditUris.set(uri.toString(), uri)
		this.postMessage({ type: "lineEdited", file, line, newContent })
	}

	private async splitLine(
		file: string,
		line: number,
		before: string,
		after: string,
	): Promise<void> {
		const uri = await applyLineSplit(file, line, before, after)
		this.pendingEditUris.set(uri.toString(), uri)
		this.postMessage({ type: "lineEdited", file, line, newContent: before })
	}

	private async joinLines(
		file: string,
		line: number,
		mergedContent: string,
	): Promise<void> {
		const uri = await applyLineJoin(file, line, mergedContent)
		if (!uri) return
		this.pendingEditUris.set(uri.toString(), uri)
		this.postMessage({
			type: "lineEdited",
			file,
			line: line - 1,
			newContent: mergedContent,
		})
	}

	private async saveEdits(): Promise<void> {
		const uris = [...this.pendingEditUris.values()]
		this.pendingEditUris.clear()
		await saveEditedDocuments(uris)
		this.postMessage({ type: "editsSaved", count: uris.length })
	}

	// Re-tokenizes a single line as it is edited in the webview. The text comes
	// from the webview (it may not be on disk yet); preamble grammar state is
	// built from the open document buffer when available — disk may be stale
	// while edits are pending — falling back to the file on disk.
	private async tokenizeLine(
		file: string,
		line: number,
		text: string,
	): Promise<void> {
		const openDocument = vscode.workspace.textDocuments.find(
			(doc) => doc.uri.fsPath === file,
		)
		const tokensByLine = await this.tokenizer.tokenizeFileGroups(
			[{ startLine: line - 1, lines: [text] }],
			file,
			openDocument?.getText().split("\n"),
		)
		this.postMessage({
			type: "lineTokens",
			file,
			line,
			text,
			tokens: tokensByLine.get(line - 1) ?? [],
		})
	}

	private persistState(state: SearchState): void {
		void this.globalState.update(STATE_KEY, state)
	}

	private cancelSearch(): void {
		this.engine.cancel()
		this.searchTokenSource?.cancel()
		this.searchTokenSource?.dispose()
		this.searchTokenSource = null
		this.tokenizationQueryId = null
	}
}
