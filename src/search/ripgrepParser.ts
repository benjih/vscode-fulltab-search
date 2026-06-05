import { ContextLine, SearchMatch, SearchQuery } from './types';
import { splitPatterns } from './searchUtils';

export const MAX_RESULTS = 10_000;
export const CONTEXT_LINES = 3;

export interface RipgrepLine {
	type: 'match' | 'context' | 'begin' | 'end' | 'summary';
	data?: {
		path?: { text: string };
		lines?: { text: string };
		line_number?: number;
		submatches?: Array<{ start: number; end: number; match: { text: string } }>;
	};
}

export type RawSearchMatch = Omit<SearchMatch, 'id' | 'breadcrumb'>;

export interface RipgrepParseState {
	matches: RawSearchMatch[];
	pendingBefore: ContextLine[];
	currentMatch: RawSearchMatch | null;
}

export function createRipgrepParseState(): RipgrepParseState {
	return {
		matches: [],
		pendingBefore: [],
		currentMatch: null,
	};
}

export function parseRipgrepLine(line: string, state: RipgrepParseState): void {
	if (!line.trim()) {
		return;
	}

	let parsed: RipgrepLine;
	try {
		parsed = JSON.parse(line) as RipgrepLine;
	} catch {
		return;
	}

	switch (parsed.type) {
		case 'begin':
			state.pendingBefore = [];
			state.currentMatch = null;
			break;
		case 'context':
			if (parsed.data?.lines?.text) {
				const contextLine: ContextLine = {
					line: parsed.data.line_number ?? 0,
					text: parsed.data.lines.text.replace(/\r?\n$/, ''),
				};
				if (state.currentMatch) {
					state.currentMatch.contextAfter.push(contextLine);
				} else {
					state.pendingBefore.push(contextLine);
				}
			}
			break;
		case 'match':
			if (parsed.data?.path?.text && parsed.data.lines?.text) {
				const submatch = parsed.data.submatches?.[0];
				if (!submatch) {
					break;
				}

				const lineText = parsed.data.lines.text.replace(/\r?\n$/, '');
				const contextBefore = state.currentMatch
					? [...state.currentMatch.contextAfter]
					: [...state.pendingBefore];
				const match: RawSearchMatch = {
					file: parsed.data.path.text,
					relativePath: parsed.data.path.text,
					line: parsed.data.line_number ?? 1,
					column: submatch.start,
					lineText,
					matchStart: submatch.start,
					matchEnd: submatch.end,
					contextBefore,
					contextAfter: [],
				};
				state.matches.push(match);
				state.currentMatch = match;
				state.pendingBefore = [];
			}
			break;
		case 'end':
			state.pendingBefore = [];
			state.currentMatch = null;
			break;
	}
}

export function buildRipgrepArgs(query: SearchQuery, rootPath: string): string[] {
	const args = [
		'--json',
		'--line-number',
		'--no-heading',
		`--max-count=${MAX_RESULTS}`,
		`-C${CONTEXT_LINES}`,
	];

	if (query.caseSensitive) {
		args.push('--case-sensitive');
	} else {
		args.push('--ignore-case');
	}

	if (query.wholeWord) {
		args.push('--word-regexp');
	}

	if (query.useRegex) {
		args.push('-e', query.pattern);
	} else {
		args.push('-F', query.pattern);
	}

	for (const pattern of splitPatterns(query.include)) {
		args.push('-g', pattern);
	}

	for (const pattern of splitPatterns(query.exclude)) {
		args.push('-g', `!${pattern}`);
	}

	args.push(rootPath);
	return args;
}
