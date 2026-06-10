import { spawn } from "node:child_process"
import * as fs from "node:fs"
import { rgPath } from "@vscode/ripgrep"
import * as vscode from "vscode"
import { createTimer, searchQueryDetails } from "../debug/metrics"
import {
	buildRipgrepArgs,
	createRipgrepParseState,
	MAX_RESULTS,
	parseRipgrepLine,
} from "./ripgrepParser"
import { buildBreadcrumb, groupByFile, splitLines } from "./searchUtils"
import type {
	ContextLine,
	SearchMatch,
	SearchQuery,
	SearchResults,
} from "./types"

const EXPAND_CHUNK = 10

// applyEdit only updates in-memory documents and leaves them dirty — it never
// writes to disk. Search reads from disk via ripgrep, so edited documents must
// be saved or replacements are invisible to the next search (and lost entirely
// for files not open in an editor).
export async function saveEditedDocuments(uris: vscode.Uri[]): Promise<void> {
	for (const uri of uris) {
		const document = vscode.workspace.textDocuments.find(
			(doc) => doc.uri.toString() === uri.toString(),
		)
		if (document?.isDirty) {
			await document.save()
		}
	}
}

export class SearchEngine {
	private activeProcess: ReturnType<typeof spawn> | null = null

	cancel(): void {
		if (this.activeProcess) {
			this.activeProcess.kill()
			this.activeProcess = null
		}
	}

	async search(
		query: SearchQuery,
		token: vscode.CancellationToken,
	): Promise<SearchResults> {
		this.cancel()
		const queryDetails = searchQueryDetails(query)
		const totalTimer = createTimer("search", queryDetails)

		const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
		if (!workspaceFolder) {
			totalTimer.end({ matches: 0, reason: "no-workspace" })
			return { queryId: query.id, fileResults: [], total: 0, truncated: false }
		}

		if (!query.pattern.trim()) {
			totalTimer.end({ matches: 0, reason: "empty-pattern" })
			return { queryId: query.id, fileResults: [], total: 0, truncated: false }
		}

		const rootPath = workspaceFolder.uri.fsPath
		const args = buildRipgrepArgs(query, rootPath)

		const ripgrepTimer = createTimer("search.ripgrep", queryDetails)
		const rawMatches = await this.runRipgrep(args, token)
		ripgrepTimer.end({ matches: rawMatches.length })

		const breadcrumbTimer = createTimer("search.breadcrumbs", queryDetails)
		const fileLinesCache = new Map<string, string[] | null>()
		const matches = rawMatches.map((match, index) => ({
			...match,
			id: index,
			breadcrumb: this.getBreadcrumb(match.file, match.line, fileLinesCache),
		}))
		breadcrumbTimer.end({ matches: matches.length })

		const groupTimer = createTimer("search.groupByFile", queryDetails)
		const fileResults = groupByFile(matches, rootPath)
		groupTimer.end({ files: fileResults.length })

		const truncated = matches.length >= MAX_RESULTS
		totalTimer.end({
			matches: matches.length,
			files: fileResults.length,
			truncated,
		})

		return {
			queryId: query.id,
			fileResults,
			total: matches.length,
			truncated,
		}
	}

	async replaceAll(
		query: SearchQuery,
		token: vscode.CancellationToken,
	): Promise<number> {
		const queryDetails = searchQueryDetails(query)
		const totalTimer = createTimer("replaceAll", queryDetails)
		const results = await this.search(query, token)
		const edit = new vscode.WorkspaceEdit()
		const editedUris: vscode.Uri[] = []
		let count = 0

		for (const fileResult of results.fileResults) {
			const uri = vscode.Uri.file(fileResult.file)
			editedUris.push(uri)
			for (const match of fileResult.matches) {
				const range = new vscode.Range(
					match.line - 1,
					match.matchStart,
					match.line - 1,
					match.matchEnd,
				)
				edit.replace(uri, range, query.replace)
				count++
			}
		}

		const applyTimer = createTimer("replaceAll.applyEdit")
		if (count > 0) {
			const applied = await vscode.workspace.applyEdit(edit)
			if (!applied) {
				applyTimer.end({ replacements: count, error: true })
				totalTimer.end({ replacements: count, error: true })
				throw new Error("Failed to apply replacement edits")
			}
			await saveEditedDocuments(editedUris)
		}
		applyTimer.end({ replacements: count })

		totalTimer.end({ replacements: count })
		return count
	}

	expandContext(
		filePath: string,
		direction: "before" | "after",
		anchorLine: number,
		count: number = EXPAND_CHUNK,
	): { lines: ContextLine[]; hasMore: boolean } {
		const timer = createTimer("expandContext", { direction })
		const content = fs.readFileSync(filePath, "utf8")
		const allLines = content.split(/\r?\n/)
		const totalLines = allLines.length

		if (direction === "before") {
			const endLine = anchorLine - 1
			if (endLine < 1) {
				timer.end({ lines: 0 })
				return { lines: [], hasMore: false }
			}
			const startLine = Math.max(1, endLine - count + 1)
			const lines = this.sliceLines(allLines, startLine, endLine)
			timer.end({ lines: lines.length })
			return { lines, hasMore: startLine > 1 }
		}

		const startLine = anchorLine + 1
		if (startLine > totalLines) {
			timer.end({ lines: 0 })
			return { lines: [], hasMore: false }
		}
		const endLine = Math.min(totalLines, startLine + count - 1)
		const lines = this.sliceLines(allLines, startLine, endLine)
		timer.end({ lines: lines.length })
		return { lines, hasMore: endLine < totalLines }
	}

	private sliceLines(
		allLines: string[],
		startLine: number,
		endLine: number,
	): ContextLine[] {
		const lines: ContextLine[] = []
		for (let line = startLine; line <= endLine; line++) {
			lines.push({ line, text: allLines[line - 1] ?? "" })
		}
		return lines
	}

	private runRipgrep(
		args: string[],
		token: vscode.CancellationToken,
	): Promise<Omit<SearchMatch, "id" | "breadcrumb">[]> {
		return new Promise((resolve, reject) => {
			const state = createRipgrepParseState()
			let stderr = ""

			const child = spawn(rgPath, args, { windowsHide: true })
			this.activeProcess = child

			const cancelListener = token.onCancellationRequested(() => {
				child.kill()
			})

			// Buffer across chunks: a single ripgrep JSON line can exceed the
			// stream chunk size (e.g. minified tsconfig.tsbuildinfo), so we hold
			// back anything after the last \n and prepend it to the next chunk.
			let stdoutBuffer = ""
			child.stdout.on("data", (chunk: Buffer) => {
				const { lines, remainder } = splitLines(
					stdoutBuffer,
					chunk.toString("utf8"),
				)
				stdoutBuffer = remainder
				for (const line of lines) {
					parseRipgrepLine(line, state)

					if (state.matches.length >= MAX_RESULTS) {
						child.kill()
					}
				}
			})

			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf8")
			})

			child.on("error", (error) => {
				cancelListener.dispose()
				this.activeProcess = null
				reject(error)
			})

			child.on("close", (code) => {
				cancelListener.dispose()
				this.activeProcess = null

				if (token.isCancellationRequested) {
					resolve(state.matches)
					return
				}

				if (code !== 0 && code !== 1 && stderr.trim()) {
					reject(new Error(stderr.trim()))
					return
				}

				resolve(state.matches)
			})
		})
	}

	private getBreadcrumb(
		filePath: string,
		matchLine: number,
		fileLinesCache: Map<string, string[] | null>,
	): string {
		let lines = fileLinesCache.get(filePath)
		if (lines === undefined) {
			try {
				lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/)
			} catch {
				lines = null
			}
			fileLinesCache.set(filePath, lines)
		}
		return lines ? buildBreadcrumb(lines, matchLine) : ""
	}
}
