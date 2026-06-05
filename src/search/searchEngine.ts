import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as fsPromises from "node:fs/promises"
import { rgPath } from "@vscode/ripgrep"
import * as vscode from "vscode"
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

		const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
		if (!workspaceFolder) {
			return { queryId: query.id, fileResults: [], total: 0, truncated: false }
		}

		if (!query.pattern.trim()) {
			return { queryId: query.id, fileResults: [], total: 0, truncated: false }
		}

		const rootPath = workspaceFolder.uri.fsPath
		const args = buildRipgrepArgs(query, rootPath)
		const rawMatches = await this.runRipgrep(args, token)
		const fileCache = new Map<string, string[]>()
		const matches = await Promise.all(
			rawMatches.map(async (match, index) => ({
				...match,
				id: index,
				breadcrumb: await this.getBreadcrumb(match.file, match.line, fileCache),
			})),
		)

		return {
			queryId: query.id,
			fileResults: groupByFile(matches, rootPath),
			total: matches.length,
			truncated: matches.length >= MAX_RESULTS,
		}
	}

	async replaceAll(
		query: SearchQuery,
		token: vscode.CancellationToken,
	): Promise<number> {
		const results = await this.search(query, token)
		const edit = new vscode.WorkspaceEdit()
		let count = 0

		for (const fileResult of results.fileResults) {
			const uri = vscode.Uri.file(fileResult.file)
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

		if (count > 0) {
			await vscode.workspace.applyEdit(edit)
		}

		return count
	}

	expandContext(
		filePath: string,
		direction: "before" | "after",
		anchorLine: number,
		count: number = EXPAND_CHUNK,
	): { lines: ContextLine[]; hasMore: boolean } {
		const content = fs.readFileSync(filePath, "utf8")
		const allLines = content.split(/\r?\n/)
		const totalLines = allLines.length

		if (direction === "before") {
			const endLine = anchorLine - 1
			if (endLine < 1) {
				return { lines: [], hasMore: false }
			}
			const startLine = Math.max(1, endLine - count + 1)
			const lines = this.sliceLines(allLines, startLine, endLine)
			return { lines, hasMore: startLine > 1 }
		}

		const startLine = anchorLine + 1
		if (startLine > totalLines) {
			return { lines: [], hasMore: false }
		}
		const endLine = Math.min(totalLines, startLine + count - 1)
		const lines = this.sliceLines(allLines, startLine, endLine)
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
				const { lines, remainder } = splitLines(stdoutBuffer, chunk.toString("utf8"))
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

	private async getBreadcrumb(
		filePath: string,
		matchLine: number,
		cache: Map<string, string[]>,
	): Promise<string> {
		try {
			let lines = cache.get(filePath)
			if (!lines) {
				const content = await fsPromises.readFile(filePath, "utf8")
				lines = content.split(/\r?\n/)
				cache.set(filePath, lines)
			}
			return buildBreadcrumb(lines, matchLine)
		} catch {
			return ""
		}
	}
}
