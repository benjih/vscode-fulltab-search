import * as path from "node:path"
import type { FileResult, SearchMatch } from "./types"

// Appends chunk to buffer, returns complete lines and the leftover incomplete line.
// Callers should store the returned remainder as the new buffer.
export function splitLines(buffer: string, chunk: string): { lines: string[]; remainder: string } {
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

export function buildBreadcrumb(lines: string[], matchLine: number): string {
	const parts: string[] = []

	for (let i = matchLine - 2; i >= 0 && parts.length < 4; i--) {
		const line = lines[i]
		const symbol = extractSymbol(line)
		if (symbol) {
			parts.unshift(symbol)
		}
	}

	return parts.join(" › ")
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
