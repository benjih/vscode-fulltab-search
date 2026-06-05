import { rgPath } from '@vscode/ripgrep';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ContextLine, FileResult, SearchMatch, SearchQuery, SearchResults } from './types';

const MAX_RESULTS = 10_000;
const CONTEXT_LINES = 3;
const EXPAND_CHUNK = 10;

interface RipgrepLine {
	type: 'match' | 'context' | 'begin' | 'end' | 'summary';
	data?: {
		path?: { text: string };
		lines?: { text: string };
		line_number?: number;
		submatches?: Array<{ start: number; end: number; match: { text: string } }>;
	};
}

export class SearchEngine {
	private activeProcess: ReturnType<typeof spawn> | null = null;

	cancel(): void {
		if (this.activeProcess) {
			this.activeProcess.kill();
			this.activeProcess = null;
		}
	}

	async search(query: SearchQuery, token: vscode.CancellationToken): Promise<SearchResults> {
		this.cancel();

		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			return { queryId: query.id, fileResults: [], total: 0, truncated: false };
		}

		if (!query.pattern.trim()) {
			return { queryId: query.id, fileResults: [], total: 0, truncated: false };
		}

		const rootPath = workspaceFolder.uri.fsPath;
		const args = this.buildArgs(query, rootPath);
		const rawMatches = await this.runRipgrep(args, token);
		const matches = rawMatches.map((match, index) => ({
			...match,
			id: index,
			breadcrumb: this.getBreadcrumb(match.file, match.line),
		}));

		return {
			queryId: query.id,
			fileResults: groupByFile(matches, rootPath),
			total: matches.length,
			truncated: matches.length >= MAX_RESULTS,
		};
	}

	async replaceAll(
		query: SearchQuery,
		token: vscode.CancellationToken
	): Promise<number> {
		const results = await this.search(query, token);
		const edit = new vscode.WorkspaceEdit();
		let count = 0;

		for (const fileResult of results.fileResults) {
			const uri = vscode.Uri.file(fileResult.file);
			for (const match of fileResult.matches) {
				const range = new vscode.Range(
					match.line - 1,
					match.matchStart,
					match.line - 1,
					match.matchEnd
				);
				edit.replace(uri, range, query.replace);
				count++;
			}
		}

		if (count > 0) {
			await vscode.workspace.applyEdit(edit);
		}

		return count;
	}

	expandContext(
		filePath: string,
		direction: 'before' | 'after',
		anchorLine: number,
		count: number = EXPAND_CHUNK
	): { lines: ContextLine[]; hasMore: boolean } {
		const content = fs.readFileSync(filePath, 'utf8');
		const allLines = content.split(/\r?\n/);
		const totalLines = allLines.length;

		if (direction === 'before') {
			const endLine = anchorLine - 1;
			if (endLine < 1) {
				return { lines: [], hasMore: false };
			}
			const startLine = Math.max(1, endLine - count + 1);
			const lines = this.sliceLines(allLines, startLine, endLine);
			return { lines, hasMore: startLine > 1 };
		}

		const startLine = anchorLine + 1;
		if (startLine > totalLines) {
			return { lines: [], hasMore: false };
		}
		const endLine = Math.min(totalLines, startLine + count - 1);
		const lines = this.sliceLines(allLines, startLine, endLine);
		return { lines, hasMore: endLine < totalLines };
	}

	private sliceLines(allLines: string[], startLine: number, endLine: number): ContextLine[] {
		const lines: ContextLine[] = [];
		for (let line = startLine; line <= endLine; line++) {
			lines.push({ line, text: allLines[line - 1] ?? '' });
		}
		return lines;
	}

	private buildArgs(query: SearchQuery, rootPath: string): string[] {
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

	private runRipgrep(
		args: string[],
		token: vscode.CancellationToken
	): Promise<Omit<SearchMatch, 'id' | 'breadcrumb'>[]> {
		return new Promise((resolve, reject) => {
			const matches: Omit<SearchMatch, 'id' | 'breadcrumb'>[] = [];
			let pendingBefore: ContextLine[] = [];
			let currentMatch: Omit<SearchMatch, 'id' | 'breadcrumb'> | null = null;
			let stderr = '';

			const child = spawn(rgPath, args, { windowsHide: true });
			this.activeProcess = child;

			const cancelListener = token.onCancellationRequested(() => {
				child.kill();
			});

			child.stdout.on('data', (chunk: Buffer) => {
				for (const line of chunk.toString('utf8').split('\n')) {
					if (!line.trim()) {
						continue;
					}

					let parsed: RipgrepLine;
					try {
						parsed = JSON.parse(line) as RipgrepLine;
					} catch {
						continue;
					}

					switch (parsed.type) {
						case 'begin':
							pendingBefore = [];
							currentMatch = null;
							break;
						case 'context':
							if (parsed.data?.lines?.text) {
								const contextLine: ContextLine = {
									line: parsed.data.line_number ?? 0,
									text: parsed.data.lines.text.replace(/\r?\n$/, ''),
								};
								if (currentMatch) {
									currentMatch.contextAfter.push(contextLine);
								} else {
									pendingBefore.push(contextLine);
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
								const contextBefore = currentMatch
									? [...currentMatch.contextAfter]
									: [...pendingBefore];
								const match: Omit<SearchMatch, 'id' | 'breadcrumb'> = {
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
								matches.push(match);
								currentMatch = match;
								pendingBefore = [];
							}
							break;
						case 'end':
							pendingBefore = [];
							currentMatch = null;
							break;
					}

					if (matches.length >= MAX_RESULTS) {
						child.kill();
					}
				}
			});

			child.stderr.on('data', (chunk: Buffer) => {
				stderr += chunk.toString('utf8');
			});

			child.on('error', (error) => {
				cancelListener.dispose();
				this.activeProcess = null;
				reject(error);
			});

			child.on('close', (code) => {
				cancelListener.dispose();
				this.activeProcess = null;

				if (token.isCancellationRequested) {
					resolve(matches);
					return;
				}

				if (code !== 0 && code !== 1 && stderr.trim()) {
					reject(new Error(stderr.trim()));
					return;
				}

				resolve(matches);
			});
		});
	}

	private getBreadcrumb(filePath: string, matchLine: number): string {
		try {
			const content = fs.readFileSync(filePath, 'utf8');
			const lines = content.split(/\r?\n/);
			const parts: string[] = [];

			for (let i = matchLine - 2; i >= 0 && parts.length < 4; i--) {
				const line = lines[i];
				const symbol = extractSymbol(line);
				if (symbol) {
					parts.unshift(symbol);
				}
			}

			return parts.join(' › ');
		} catch {
			return '';
		}
	}
}

function splitPatterns(value: string): string[] {
	return value
		.split(',')
		.map((part) => part.trim())
		.filter(Boolean);
}

function extractSymbol(line: string): string | null {
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

function groupByFile(matches: SearchMatch[], workspaceRoot: string): FileResult[] {
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
