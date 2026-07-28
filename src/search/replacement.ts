import type { SearchState } from "./types"

// Capture-group references in the replacement field, matching VS Code's find
// widget: `$$` (a literal $), `$&` (the whole match), `$0`-`$99` (numbered
// groups) and `$<name>` (named groups). Anything else starting with `$` is
// left alone.
const CAPTURE_REFERENCE = /\$(?:(\$)|(&)|<([^>]*)>|(\d{1,2}))/g

export function hasCaptureReference(replacement: string): boolean {
	return new RegExp(CAPTURE_REFERENCE.source).test(replacement)
}

// Resolves the text a single match is replaced with. Plain (non-regex)
// searches and replacements without capture references always yield the
// literal replacement string; only regex searches expand.
export type ReplacementResolver = (
	lineText: string,
	matchStart: number,
	matchEnd: number,
) => string

// Ripgrep runs the Rust regex engine, so the capture groups it found are not
// available to us — they have to be recovered by re-running the pattern in
// JavaScript at the offsets ripgrep reported. The two engines agree on the
// syntax used by real find-and-replace patterns, and every disagreement is
// caught rather than guessed at: a pattern JS cannot compile throws up front,
// and a re-run that lands on a different span than ripgrep's throws for that
// match. Both abort the replacement before any edit is applied.
export function createReplacementResolver(
	query: Pick<
		SearchState,
		"pattern" | "replace" | "useRegex" | "caseSensitive" | "wholeWord"
	>,
): ReplacementResolver {
	if (!query.useRegex || !hasCaptureReference(query.replace)) {
		return () => query.replace
	}

	// --word-regexp constrains which span ripgrep reports, so the JS side has
	// to be constrained the same way or alternations can land on a different
	// span. The wrapper is non-capturing: group numbers stay as the user wrote
	// them.
	const source = query.wholeWord ? `\\b(?:${query.pattern})\\b` : query.pattern
	let regex: RegExp
	try {
		regex = new RegExp(source, query.caseSensitive ? "y" : "iy")
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)
		throw new Error(
			`Cannot expand capture group references in the replacement: the pattern is not a valid JavaScript regular expression (${detail}).`,
		)
	}

	return (lineText, matchStart, matchEnd) => {
		regex.lastIndex = matchStart
		const match = regex.exec(lineText)
		if (!match || match[0].length !== matchEnd - matchStart) {
			throw new Error(
				`Cannot expand capture group references in the replacement: the pattern matches "${lineText.slice(matchStart, matchEnd)}" differently in JavaScript than in the search engine.`,
			)
		}
		return expandReferences(query.replace, match)
	}
}

function expandReferences(replacement: string, match: RegExpExecArray): string {
	return replacement.replace(
		CAPTURE_REFERENCE,
		(token, dollar, ampersand, name, digits) => {
			if (dollar) return "$"
			if (ampersand) return match[0]
			if (name !== undefined) return match.groups?.[name] ?? ""

			// A group the pattern declares but that did not participate in this
			// match expands to nothing, as it does in String.prototype.replace.
			if (Number(digits) < match.length) return match[Number(digits)] ?? ""
			// `$12` with only one group means group 1 followed by a literal "2",
			// the same fallback String.prototype.replace applies.
			if (digits.length === 2 && Number(digits[0]) < match.length) {
				return (match[Number(digits[0])] ?? "") + digits[1]
			}
			return token
		},
	)
}
