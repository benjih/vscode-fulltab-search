import { spawn } from "node:child_process"
import * as fs from "node:fs"
import { rgPath } from "@vscode/ripgrep"
import * as vscode from "vscode"
import { createTimer, searchQueryDetails, timed } from "../debug/metrics"
import { createReplacementResolver } from "./replacement"
import {
	buildRipgrepArgs,
	createRipgrepParseState,
	MAX_RESULTS,
	parseRipgrepLine,
} from "./ripgrepParser"
import {
	breadcrumbFromIndex,
	buildSymbolIndex,
	groupByFile,
	type SymbolEntry,
	splitLines,
} from "./searchUtils"
import type {
	ContextLine,
	SearchMatch,
	SearchQuery,
	SearchResults,
} from "./types"

const EXPAND_CHUNK = 10

export interface ReplaceAllResult {
	replaced: number
	// The underlying search hit the MAX_RESULTS cap: matches beyond it exist
	// and were not replaced.
	truncated: boolean
	// Nothing was replaced because a truncated run was not approved.
	cancelled: boolean
}

// Replacement failures are all pattern-level problems the user can act on, but
// only once they know which match tripped them.
function withMatchLocation(
	relativePath: string,
	line: number,
	resolve: () => string,
): string {
	try {
		return resolve()
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)
		throw new Error(`${relativePath}:${line} — ${detail}`)
	}
}

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

		const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
		if (!workspaceFolder) {
			createTimer("search", queryDetails).end({
				matches: 0,
				reason: "no-workspace",
			})
			return { queryId: query.id, fileResults: [], total: 0, truncated: false }
		}

		if (!query.pattern.trim()) {
			createTimer("search", queryDetails).end({
				matches: 0,
				reason: "empty-pattern",
			})
			return { queryId: query.id, fileResults: [], total: 0, truncated: false }
		}

		const rootPath = workspaceFolder.uri.fsPath
		const args = buildRipgrepArgs(query, rootPath)

		return timed(
			"search",
			queryDetails,
			async () => {
				const { matches: rawMatches, warning: ripgrepWarning } = await timed(
					"search.ripgrep",
					queryDetails,
					() => this.runRipgrep(args, token),
					(r) => ({ matches: r.matches.length }),
				)

				const symbolIndexCache = new Map<
					string,
					Promise<SymbolEntry[] | null>
				>()
				const matches = await timed(
					"search.breadcrumbs",
					queryDetails,
					() =>
						Promise.all(
							rawMatches.map(async (match, index) => ({
								...match,
								id: index,
								breadcrumb: await this.getBreadcrumb(
									match.file,
									match.line,
									symbolIndexCache,
								),
							})),
						),
					(m) => ({ matches: m.length }),
				)

				const fileResults = await timed(
					"search.groupByFile",
					queryDetails,
					() => groupByFile(matches, rootPath),
					(files) => ({ files: files.length }),
				)

				const truncated = matches.length >= MAX_RESULTS
				return {
					queryId: query.id,
					fileResults,
					total: matches.length,
					truncated,
					warning: ripgrepWarning,
				}
			},
			(r) => ({
				matches: r.total,
				files: r.fileResults.length,
				truncated: r.truncated,
			}),
		)
	}

	// A truncated search only knows about the first MAX_RESULTS matches, so
	// replacing them all would leave the rest silently untouched while
	// reporting success. Truncated runs are refused unless `onTruncated`
	// explicitly approves replacing the partial set.
	async replaceAll(
		query: SearchQuery,
		token: vscode.CancellationToken,
		options: {
			onTruncated?: (matched: number) => Promise<boolean>
		} = {},
	): Promise<ReplaceAllResult> {
		const queryDetails = searchQueryDetails(query)
		return timed(
			"replaceAll",
			queryDetails,
			async (): Promise<ReplaceAllResult> => {
				const results = await this.search(query, token)

				if (results.truncated) {
					const approved = (await options.onTruncated?.(results.total)) ?? false
					if (!approved) {
						return { replaced: 0, truncated: true, cancelled: true }
					}
				}

				// Resolving every replacement before touching the workspace keeps a
				// capture-group failure from applying a half-finished rename.
				const resolveReplacement = createReplacementResolver(query)
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
						edit.replace(
							uri,
							range,
							withMatchLocation(fileResult.relativePath, match.line, () =>
								resolveReplacement(
									match.lineText,
									match.matchStart,
									match.matchEnd,
								),
							),
						)
						count++
					}
				}

				if (count > 0) {
					await timed(
						"replaceAll.applyEdit",
						undefined,
						async () => {
							const applied = await vscode.workspace.applyEdit(edit)
							if (!applied) {
								throw new Error("Failed to apply replacement edits")
							}
							await saveEditedDocuments(editedUris)
						},
						() => ({ replacements: count }),
					)
				}

				return {
					replaced: count,
					truncated: results.truncated,
					cancelled: false,
				}
			},
			(r) => ({ replacements: r.replaced, truncated: r.truncated }),
		)
	}

	async expandContext(
		filePath: string,
		direction: "before" | "after",
		anchorLine: number,
		count: number = EXPAND_CHUNK,
	): Promise<{ lines: ContextLine[]; hasMore: boolean }> {
		const timer = createTimer("expandContext", { direction })
		const content = await fs.promises.readFile(filePath, "utf8")
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
	): Promise<{
		matches: Omit<SearchMatch, "id" | "breadcrumb">[]
		warning?: string
	}> {
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
					resolve({ matches: state.matches })
					return
				}

				const trimmedStderr = stderr.trim()
				if (code !== 0 && code !== 1 && trimmedStderr) {
					// ripgrep exits 2 both for fatal errors (bad pattern/glob — nothing
					// was found) and for non-fatal per-file errors (unreadable file,
					// broken symlink) encountered while otherwise searching normally.
					// Only treat it as fatal when no matches were collected; otherwise
					// keep the good matches and surface the stderr as a warning.
					if (state.matches.length === 0) {
						reject(new Error(trimmedStderr))
						return
					}
					resolve({ matches: state.matches, warning: trimmedStderr })
					return
				}

				resolve({ matches: state.matches })
			})
		})
	}

	private async getBreadcrumb(
		filePath: string,
		matchLine: number,
		symbolIndexCache: Map<string, Promise<SymbolEntry[] | null>>,
	): Promise<string> {
		let pending = symbolIndexCache.get(filePath)
		if (pending === undefined) {
			pending = fs.promises
				.readFile(filePath, "utf8")
				.then((content) => buildSymbolIndex(content.split(/\r?\n/)))
				.catch(() => null)
			symbolIndexCache.set(filePath, pending)
		}
		const index = await pending
		return index ? breadcrumbFromIndex(index, matchLine) : ""
	}
}
