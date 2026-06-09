import * as fs from "node:fs"
import * as path from "node:path"
import * as vscode from "vscode"
import { appendOutput } from "../debug/metrics"
import type { FileIconFont } from "./types"

interface ThemeFont {
	id: string
	src: Array<{ path: string; format: string }>
}

interface ThemeIconDef {
	iconPath?: string
	fontCharacter?: string
	fontColor?: string
	fontId?: string
}

interface ThemeJson {
	iconDefinitions?: Record<string, ThemeIconDef>
	fileExtensions?: Record<string, string>
	fileNames?: Record<string, string>
	languageIds?: Record<string, string>
	file?: string
	fonts?: ThemeFont[]
}

function stripJsoncComments(input: string): string {
	let result = ""
	let i = 0
	while (i < input.length) {
		const ch = input[i]
		if (ch === '"') {
			result += ch
			i++
			while (i < input.length) {
				const sc = input[i]
				result += sc
				i++
				if (sc === "\\") {
					if (i < input.length) {
						result += input[i]
						i++
					}
				} else if (sc === '"') {
					break
				}
			}
		} else if (ch === "/" && input[i + 1] === "/") {
			while (i < input.length && input[i] !== "\n") i++
		} else if (ch === "/" && input[i + 1] === "*") {
			i += 2
			while (i < input.length && !(input[i] === "*" && input[i + 1] === "/"))
				i++
			i += 2
		} else {
			result += ch
			i++
		}
	}
	return result
}

function charFromCssEscape(cssEscape: string): string {
	const hex = cssEscape.replace(/^\\+/, "")
	const codePoint = parseInt(hex, 16)
	return Number.isNaN(codePoint) ? cssEscape : String.fromCodePoint(codePoint)
}

export class FileIconResolver {
	private themeRoot: vscode.Uri | null = null

	// SVG-based icons
	private svgDefs = new Map<string, vscode.Uri>()

	// Font-based icons
	private fontFamilies: Array<{
		id: string
		paths: Array<{ absolute: string; format: string }>
	}> = []
	private fontIconDefs = new Map<
		string,
		{ fontId: string; char: string; color: string }
	>()

	// file extension / filename / languageId → definition ID
	private byExtension = new Map<string, string>()
	private byFileName = new Map<string, string>()
	private byLanguageId = new Map<string, string>()

	// file extension → VS Code language ID (built from all extension contributions)
	private extToLangId = new Map<string, string>()

	private defaultId: string | null = null

	async load(): Promise<void> {
		const themeId = vscode.workspace
			.getConfiguration("workbench")
			.get<string>("iconTheme")

		appendOutput(
			`[FileIconResolver] workbench.iconTheme = ${themeId ?? "unset"}`,
		)
		if (!themeId) return

		// Build file-extension → language-ID map from all installed extensions
		for (const ext of vscode.extensions.all) {
			const languages = ext.packageJSON?.contributes?.languages as
				| Array<{ id?: string; extensions?: string[] }>
				| undefined
			if (!Array.isArray(languages)) continue
			for (const lang of languages) {
				if (!lang.id || !Array.isArray(lang.extensions)) continue
				for (const fileExt of lang.extensions) {
					// extensions are like ".yml", ".yaml" — strip the leading dot
					const key = fileExt.replace(/^\./, "").toLowerCase()
					if (key) this.extToLangId.set(key, lang.id)
				}
			}
		}

		appendOutput(
			`[FileIconResolver] built ${this.extToLangId.size} ext→langId mappings`,
		)

		for (const ext of vscode.extensions.all) {
			const iconThemes = ext.packageJSON?.contributes?.iconThemes as
				| Array<{ id: string; path: string }>
				| undefined

			if (!Array.isArray(iconThemes)) continue

			const themeEntry = iconThemes.find((t) => t.id === themeId)
			if (!themeEntry) continue

			appendOutput(`[FileIconResolver] found theme in: ${ext.id}`)

			const themePath = path.join(ext.extensionPath, themeEntry.path)
			const themeDir = path.dirname(themePath)
			this.themeRoot = vscode.Uri.file(ext.extensionPath)

			let raw: string
			try {
				raw = fs.readFileSync(themePath, "utf8")
			} catch (e) {
				appendOutput(`[FileIconResolver] read error: ${String(e)}`)
				return
			}

			let json: ThemeJson
			try {
				json = JSON.parse(stripJsoncComments(raw)) as ThemeJson
			} catch (e) {
				appendOutput(`[FileIconResolver] parse error: ${String(e)}`)
				return
			}

			const defaultFontId = json.fonts?.[0]?.id ?? ""

			for (const font of json.fonts ?? []) {
				this.fontFamilies.push({
					id: font.id,
					paths: font.src.map((s) => ({
						absolute: path.resolve(themeDir, s.path),
						format: s.format,
					})),
				})
			}

			for (const [id, def] of Object.entries(json.iconDefinitions ?? {})) {
				if (def.iconPath) {
					this.svgDefs.set(
						id,
						vscode.Uri.file(path.resolve(themeDir, def.iconPath)),
					)
				} else if (def.fontCharacter) {
					this.fontIconDefs.set(id, {
						fontId: def.fontId ?? defaultFontId,
						char: charFromCssEscape(def.fontCharacter),
						color: def.fontColor ?? "inherit",
					})
				}
			}

			for (const [fileExt, id] of Object.entries(json.fileExtensions ?? {})) {
				this.byExtension.set(fileExt.toLowerCase(), id)
			}
			for (const [name, id] of Object.entries(json.fileNames ?? {})) {
				this.byFileName.set(name.toLowerCase(), id)
			}
			for (const [langId, id] of Object.entries(json.languageIds ?? {})) {
				this.byLanguageId.set(langId, id)
			}
			this.defaultId = json.file ?? null

			appendOutput(
				`[FileIconResolver] loaded: ${this.svgDefs.size} SVG, ` +
					`${this.fontIconDefs.size} font defs, ` +
					`${this.byExtension.size} ext, ` +
					`${this.byLanguageId.size} langId mappings`,
			)
			return
		}

		appendOutput(`[FileIconResolver] no extension found for theme: ${themeId}`)
	}

	getLocalResourceRoot(): vscode.Uri | null {
		return this.themeRoot
	}

	generateFontFaceCss(webview: vscode.Webview): string | null {
		if (this.fontFamilies.length === 0) return null
		return this.fontFamilies
			.map((f) => {
				const srcs = f.paths
					.map((p) => {
						const uri = webview.asWebviewUri(vscode.Uri.file(p.absolute))
						return `url('${uri}') format('${p.format}')`
					})
					.join(", ")
				return `@font-face { font-family: '${f.id}'; src: ${srcs}; font-weight: normal; font-style: normal; }`
			})
			.join("\n")
	}

	private lookupId(fileName: string): string | null {
		const lower = fileName.toLowerCase()
		const dotIdx = lower.lastIndexOf(".")
		const ext = dotIdx >= 0 ? lower.slice(dotIdx + 1) : ""
		const langId = this.extToLangId.get(ext)
		return (
			this.byFileName.get(lower) ??
			(langId !== undefined ? this.byLanguageId.get(langId) : undefined) ??
			this.byExtension.get(ext) ??
			this.defaultId
		)
	}

	resolveWebviewUri(fileName: string, webview: vscode.Webview): string | null {
		if (this.svgDefs.size === 0) return null
		const id = this.lookupId(fileName)
		if (!id) return null
		const uri = this.svgDefs.get(id)
		if (!uri) return null
		return webview.asWebviewUri(uri).toString()
	}

	resolveIconFont(fileName: string): FileIconFont | null {
		if (this.fontIconDefs.size === 0) return null
		const id = this.lookupId(fileName)
		if (!id) return null
		const def = this.fontIconDefs.get(id)
		if (!def) return null
		return { family: def.fontId, char: def.char, color: def.color }
	}
}
