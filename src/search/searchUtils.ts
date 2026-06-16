import * as path from "node:path"
import type { FileResult, SearchMatch } from "./types"

// Appends chunk to buffer, returns complete lines and the leftover incomplete line.
// Callers should store the returned remainder as the new buffer.
export function splitLines(
	buffer: string,
	chunk: string,
): { lines: string[]; remainder: string } {
	const combined = buffer + chunk
	const parts = combined.split("\n")
	const remainder = parts.pop() ?? ""
	return { lines: parts, remainder }
}

export function splitPatterns(value: string): string[] {
	return value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean)
}

// Mirrors VS Code's glob normalization for search include/exclude patterns:
// 1. Bare names/paths (no wildcards) become **/name/** to match anywhere in the tree.
// 2. Trailing /* converts to /** so patterns like `packages/foo/*` match files
//    at any depth inside the directory, same as VS Code's search behaviour.
// 3. Patterns with a path separator get a **/ prefix so they match anywhere,
//    not just rooted at the workspace root.
export function normalizeGlob(pattern: string): string {
	if (pattern.startsWith("**") || pattern.startsWith("/")) {
		return pattern
	}
	const hasWildcard = /[*?{[]/.test(pattern)
	if (!hasWildcard) {
		return `**/${pattern}/**`
	}
	if (pattern.includes("/")) {
		const recursive = pattern.endsWith("/*")
			? `${pattern.slice(0, -1)}**`
			: pattern
		return `**/${recursive}`
	}
	return pattern
}

export function extractSymbol(line: string): string | null {
	const patterns = [
		/^\s*(?:pub\s+)?impl(?:<[^>]+>)?\s+(?:\w+::)*(\w+)/,
		/^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,
		/^\s*(?:pub\s+)?(?:struct|enum|trait|mod)\s+(\w+)/,
		/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+(\w+)/,
		/^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
		/^\s*(?:export\s+)?(?:interface|type)\s+(\w+)/,
	]

	for (const pattern of patterns) {
		const result = pattern.exec(line)
		if (result) {
			const keyword =
				line.trim().split(/\s+/)[0]?.replace("pub", "").replace("export", "") ||
				""
			if (keyword === "impl") {
				return `impl ${result[1]}`
			}
			if (keyword === "fn" || keyword === "function" || keyword === "async") {
				return `fn ${result[1]}`
			}
			return result[1]
		}
	}

	return null
}

export interface SymbolEntry {
	line: number // 0-based line index where the symbol was declared
	symbol: string
}

// One pass over the file's lines, collecting every symbol declaration.
// Result is sorted ascending by line by construction.
export function buildSymbolIndex(lines: string[]): SymbolEntry[] {
	const index: SymbolEntry[] = []
	for (let i = 0; i < lines.length; i++) {
		const symbol = extractSymbol(lines[i])
		if (symbol) {
			index.push({ line: i, symbol })
		}
	}
	return index
}

// Nearest 4 symbols declared strictly above the match line, top-to-bottom.
// Binary-searches the sorted index instead of re-scanning the file.
export function breadcrumbFromIndex(
	index: SymbolEntry[],
	matchLine: number,
): string {
	const cutoff = matchLine - 2 // 0-based index of the line just above the match
	// rightmost-insertion search: count of entries with line <= cutoff
	let lo = 0
	let hi = index.length
	while (lo < hi) {
		const mid = (lo + hi) >> 1
		if (index[mid].line <= cutoff) {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	const start = Math.max(0, lo - 4)
	return index
		.slice(start, lo)
		.map((entry) => entry.symbol)
		.join(" › ")
}

export function groupByFile(
	matches: SearchMatch[],
	workspaceRoot: string,
): FileResult[] {
	const byFile = new Map<string, SearchMatch[]>()

	for (const match of matches) {
		const existing = byFile.get(match.file) ?? []
		existing.push(match)
		byFile.set(match.file, existing)
	}

	return [...byFile.entries()].map(([file, fileMatches]) => {
		const relativePath = path.relative(workspaceRoot, file)
		const directory = path.dirname(relativePath)
		return {
			file,
			relativePath,
			directory: directory === "." ? "" : directory,
			fileName: path.basename(file),
			matches: fileMatches,
		}
	})
}
