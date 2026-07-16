import { normalizeGlob, splitPatterns } from "./searchUtils"
import type { ContextLine, SearchMatch, SearchQuery } from "./types"

export const MAX_RESULTS = 10_000
const CONTEXT_LINES = 3

interface RipgrepLine {
	type: "match" | "context" | "begin" | "end" | "summary"
	data?: {
		path?: { text: string }
		lines?: { text: string }
		line_number?: number
		submatches?: Array<{ start: number; end: number; match: { text: string } }>
	}
}

type RawSearchMatch = Omit<SearchMatch, "id" | "breadcrumb">

export interface RipgrepParseState {
	matches: RawSearchMatch[]
	pendingBefore: ContextLine[]
	currentMatch: RawSearchMatch | null
}

export function createRipgrepParseState(): RipgrepParseState {
	return {
		matches: [],
		pendingBefore: [],
		currentMatch: null,
	}
}

// Ripgrep reports submatch offsets as byte positions in the UTF-8 line, but
// consumers (highlighting, vscode.Position/Range) index by UTF-16 code units.
// Submatches arrive in ascending order, so one incremental walk per line
// converts every offset in O(line length).
function createByteToCodeUnitConverter(
	text: string,
): (byteOffset: number) => number {
	let byte = 0
	let unit = 0
	return (byteOffset) => {
		if (byteOffset < byte) {
			byte = 0
			unit = 0
		}
		while (byte < byteOffset && unit < text.length) {
			const codePoint = text.codePointAt(unit) as number
			if (codePoint <= 0x7f) {
				byte += 1
			} else if (codePoint <= 0x7ff) {
				byte += 2
			} else if (codePoint <= 0xffff) {
				byte += 3
			} else {
				byte += 4
			}
			unit += codePoint > 0xffff ? 2 : 1
		}
		return unit
	}
}

export function parseRipgrepLine(line: string, state: RipgrepParseState): void {
	if (!line.trim()) {
		return
	}

	let parsed: RipgrepLine
	try {
		parsed = JSON.parse(line) as RipgrepLine
	} catch {
		return
	}

	switch (parsed.type) {
		case "begin":
			state.pendingBefore = []
			state.currentMatch = null
			break
		case "context":
			if (parsed.data?.lines?.text) {
				const contextLine: ContextLine = {
					line: parsed.data.line_number ?? 0,
					text: parsed.data.lines.text.replace(/\r?\n$/, ""),
				}
				if (state.currentMatch) {
					state.currentMatch.contextAfter.push(contextLine)
				} else {
					state.pendingBefore.push(contextLine)
				}
			}
			break
		case "match":
			if (parsed.data?.path?.text && parsed.data.lines?.text) {
				const submatches = parsed.data.submatches
				if (!submatches || submatches.length === 0) {
					break
				}

				const lineText = parsed.data.lines.text.replace(/\r?\n$/, "")
				const contextBefore = state.currentMatch
					? [...state.currentMatch.contextAfter]
					: [...state.pendingBefore]
				// Ripgrep emits one match event per line; every occurrence on that
				// line arrives in `submatches`. Emit a match per occurrence so
				// navigation and replace cover them all.
				const toCodeUnit = createByteToCodeUnitConverter(lineText)
				for (const submatch of submatches) {
					const matchStart = toCodeUnit(submatch.start)
					const matchEnd = toCodeUnit(submatch.end)
					const match: RawSearchMatch = {
						file: parsed.data.path.text,
						relativePath: parsed.data.path.text,
						line: parsed.data.line_number ?? 1,
						column: matchStart,
						lineText,
						matchStart,
						matchEnd,
						contextBefore,
						contextAfter: [],
					}
					state.matches.push(match)
					state.currentMatch = match
				}
				state.pendingBefore = []
			}
			break
		case "end":
			state.pendingBefore = []
			state.currentMatch = null
			break
	}
}

export function buildRipgrepArgs(
	query: SearchQuery,
	rootPath: string,
): string[] {
	const args = [
		"--json",
		"--line-number",
		"--no-heading",
		"--hidden",
		// --hidden makes ripgrep descend into .git/; exclude it so matches in
		// repository internals (config, hooks, logs) don't surface. VS Code's
		// own search does the equivalent.
		"-g",
		"!.git",
		`--max-count=${MAX_RESULTS}`,
		`-C${CONTEXT_LINES}`,
	]

	if (query.caseSensitive) {
		args.push("--case-sensitive")
	} else {
		args.push("--ignore-case")
	}

	if (query.wholeWord) {
		args.push("--word-regexp")
	}

	if (query.useRegex) {
		args.push("-e", query.pattern)
	} else {
		args.push("-F", query.pattern)
	}

	for (const pattern of splitPatterns(query.include)) {
		args.push("-g", normalizeGlob(pattern))
	}

	for (const pattern of splitPatterns(query.exclude)) {
		args.push("-g", `!${normalizeGlob(pattern)}`)
	}

	args.push(rootPath)
	return args
}
