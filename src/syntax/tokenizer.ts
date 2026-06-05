import * as fs from "node:fs"
import * as path from "node:path"
import * as vscode from "vscode"
import { createOnigScanner, createOnigString, loadWASM } from "vscode-oniguruma"
import {
	INITIAL,
	type IRawTheme,
	parseRawGrammar,
	Registry,
} from "vscode-textmate"
import type { TokenSpan } from "../search/types"

let wasmLoadPromise: Promise<void> | null = null

function ensureWasmLoaded(extensionUri: vscode.Uri): Promise<void> {
	if (wasmLoadPromise) return wasmLoadPromise
	const wasmPath = vscode.Uri.joinPath(
		extensionUri,
		"node_modules",
		"vscode-oniguruma",
		"release",
		"onig.wasm",
	).fsPath
	const wasmBin = fs.readFileSync(wasmPath)
	wasmLoadPromise = loadWASM(wasmBin)
	return wasmLoadPromise
}

function decodeTokens(
	line: string,
	tokens: Uint32Array,
	colorMap: string[],
): TokenSpan[] {
	const spans: TokenSpan[] = []
	for (let i = 0; i < tokens.length; i += 2) {
		const startIndex = tokens[i]
		const metadata = tokens[i + 1]
		const endIndex = i + 2 < tokens.length ? tokens[i + 2] : line.length
		const text = line.slice(startIndex, endIndex)
		if (!text) continue
		// Foreground color index: bits 15-23 (from vscode-textmate EncodedTokenAttributes.getForeground)
		const colorIdx = (metadata & 0xff8000) >>> 15
		const color = colorIdx > 0 ? (colorMap[colorIdx] ?? null) : null
		spans.push({ text, color })
	}
	return spans
}

export class SyntaxTokenizer {
	private readonly extensionUri: vscode.Uri
	private registry: Registry | null = null
	private scopeMap = new Map<string, string>() // scopeName → abs grammar path
	private extensionMap = new Map<string, string>() // .ext → languageId
	private langToScope = new Map<string, string>() // languageId → scopeName
	private cachedTheme: IRawTheme | null = null
	private scanned = false

	constructor(extensionUri: vscode.Uri, disposables: vscode.Disposable[]) {
		this.extensionUri = extensionUri
		disposables.push(
			vscode.window.onDidChangeActiveColorTheme(() => {
				this.registry = null
				this.cachedTheme = null
			}),
		)
	}

	private scanExtensions(): void {
		if (this.scanned) return
		this.scanned = true
		for (const ext of vscode.extensions.all) {
			const grammars: Array<{
				scopeName: string
				path: string
				language?: string
			}> = ext.packageJSON?.contributes?.grammars ?? []
			for (const g of grammars) {
				if (g.scopeName && g.path) {
					this.scopeMap.set(g.scopeName, path.join(ext.extensionPath, g.path))
					if (g.language) {
						this.langToScope.set(g.language, g.scopeName)
					}
				}
			}
			const languages: Array<{ id: string; extensions?: string[] }> =
				ext.packageJSON?.contributes?.languages ?? []
			for (const lang of languages) {
				for (const fileExt of lang.extensions ?? []) {
					this.extensionMap.set(fileExt.toLowerCase(), lang.id)
				}
			}
		}
	}

	private mergeThemeChain(
		themePath: string,
		visited = new Set<string>(),
	): IRawTheme {
		if (visited.has(themePath)) {
			return { settings: [] }
		}
		visited.add(themePath)

		const raw = JSON.parse(fs.readFileSync(themePath, "utf8")) as {
			include?: string
			tokenColors?: IRawTheme["settings"]
			name?: string
		}

		if (!raw.include) {
			return {
				name: raw.name,
				settings: raw.tokenColors ?? [],
			}
		}

		const parentPath = path.resolve(path.dirname(themePath), raw.include)
		const parent = this.mergeThemeChain(parentPath, visited)

		return {
			name: raw.name ?? (parent as { name?: string }).name,
			settings: [
				...((parent.settings as unknown[]) ?? []),
				...(raw.tokenColors ?? []),
			] as IRawTheme["settings"],
		}
	}

	private loadTheme(): IRawTheme | null {
		if (this.cachedTheme) return this.cachedTheme

		const activeThemeName = vscode.workspace
			.getConfiguration("workbench")
			.get<string>("colorTheme")
		if (!activeThemeName) return null

		for (const ext of vscode.extensions.all) {
			const themes: Array<{ id?: string; label?: string; path: string }> =
				ext.packageJSON?.contributes?.themes ?? []
			for (const t of themes) {
				if (t.id === activeThemeName || t.label === activeThemeName) {
					try {
						const absPath = path.join(ext.extensionPath, t.path)
						this.cachedTheme = this.mergeThemeChain(absPath)
						return this.cachedTheme
					} catch {
						return null
					}
				}
			}
		}
		return null
	}

	private async ensureRegistry(): Promise<Registry | null> {
		await ensureWasmLoaded(this.extensionUri)
		if (this.registry) return this.registry

		this.scanExtensions()
		const theme = this.loadTheme()
		const scopeMap = this.scopeMap

		const onigLib = Promise.resolve({ createOnigScanner, createOnigString })

		this.registry = new Registry({
			onigLib,
			theme: theme ?? undefined,
			loadGrammar: async (scopeName: string) => {
				const filePath = scopeMap.get(scopeName)
				if (!filePath) return null
				try {
					const content = fs.readFileSync(filePath, "utf8")
					return parseRawGrammar(content, filePath)
				} catch {
					return null
				}
			},
		})
		return this.registry
	}

	// Number of lines read from the actual file before each group to build correct grammar state.
	// Handles block comments and template literals that started before the visible window.
	private static readonly PREAMBLE = 200

	/**
	 * Tokenizes multiple disjoint groups of lines from a single file.
	 * Each group gets a fresh grammar state built by tokenizing up to PREAMBLE lines
	 * before its start from the actual file on disk, so nesting context (objects,
	 * block comments, template literals) is accurate even for groups deep in large files.
	 *
	 * Groups must be sorted by startLine. startLine is 0-indexed.
	 * Returns a map from 0-indexed line number to TokenSpan[].
	 */
	async tokenizeFileGroups(
		groups: Array<{ startLine: number; lines: string[] }>,
		filePath: string,
	): Promise<Map<number, TokenSpan[]>> {
		try {
			const registry = await this.ensureRegistry()
			if (!registry) return new Map()

			const fileExt = path.extname(filePath).toLowerCase()
			const langId = this.extensionMap.get(fileExt)
			const scopeName = langId ? this.langToScope.get(langId) : undefined
			if (!scopeName) return new Map()

			const grammar = await registry.loadGrammar(scopeName)
			if (!grammar) return new Map()

			const colorMap = registry.getColorMap()

			let fileLines: string[] | null = null
			try {
				fileLines = fs.readFileSync(filePath, "utf8").split("\n")
			} catch {
				fileLines = null
			}

			const result = new Map<number, TokenSpan[]>()

			for (const group of groups) {
				let ruleStack = INITIAL

				if (fileLines && group.startLine > 0) {
					const preambleStart = Math.max(
						0,
						group.startLine - SyntaxTokenizer.PREAMBLE,
					)
					for (let i = preambleStart; i < group.startLine; i++) {
						const { ruleStack: next } = grammar.tokenizeLine2(
							fileLines[i] ?? "",
							ruleStack,
						)
						ruleStack = next
					}
				}

				for (let i = 0; i < group.lines.length; i++) {
					const { tokens, ruleStack: next } = grammar.tokenizeLine2(
						group.lines[i],
						ruleStack,
					)
					ruleStack = next
					result.set(
						group.startLine + i,
						decodeTokens(group.lines[i], tokens, colorMap),
					)
				}
			}

			return result
		} catch {
			return new Map()
		}
	}

	// Used for expanded context lines where we don't have file position info.
	async tokenizeLines(
		lines: string[],
		filePath: string,
	): Promise<TokenSpan[][]> {
		const groups = [{ startLine: 0, lines }]
		const map = await this.tokenizeFileGroups(groups, filePath)
		return lines.map((_, i) => map.get(i) ?? [])
	}
}
