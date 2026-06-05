import * as path from 'path';
import { FileResult, SearchMatch } from './types';

export function splitPatterns(value: string): string[] {
	return value
		.split(',')
		.map((part) => part.trim())
		.filter(Boolean);
}

export function extractSymbol(line: string): string | null {
	const patterns = [
		/^\s*(?:pub\s+)?impl(?:<[^>]+>)?\s+(?:\w+::)*(\w+)/,
		/^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,
		/^\s*(?:pub\s+)?(?:struct|enum|trait|mod)\s+(\w+)/,
		/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+(\w+)/,
		/^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
		/^\s*(?:export\s+)?(?:interface|type)\s+(\w+)/,
	];

	for (const pattern of patterns) {
		const result = pattern.exec(line);
		if (result) {
			const keyword = line.trim().split(/\s+/)[0]?.replace('pub', '').replace('export', '') || '';
			if (keyword === 'impl') {
				return `impl ${result[1]}`;
			}
			if (keyword === 'fn' || keyword === 'function' || keyword === 'async') {
				return `fn ${result[1]}`;
			}
			return result[1];
		}
	}

	return null;
}

export function buildBreadcrumb(lines: string[], matchLine: number): string {
	const parts: string[] = [];

	for (let i = matchLine - 2; i >= 0 && parts.length < 4; i--) {
		const line = lines[i];
		const symbol = extractSymbol(line);
		if (symbol) {
			parts.unshift(symbol);
		}
	}

	return parts.join(' › ');
}

export function groupByFile(matches: SearchMatch[], workspaceRoot: string): FileResult[] {
	const byFile = new Map<string, SearchMatch[]>();

	for (const match of matches) {
		const existing = byFile.get(match.file) ?? [];
		existing.push(match);
		byFile.set(match.file, existing);
	}

	return [...byFile.entries()].map(([file, fileMatches]) => {
		const relativePath = path.relative(workspaceRoot, file);
		const directory = path.dirname(relativePath);
		return {
			file,
			relativePath,
			directory: directory === '.' ? '' : directory,
			fileName: path.basename(file),
			matches: fileMatches,
		};
	});
}
