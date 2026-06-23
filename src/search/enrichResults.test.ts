import assert from "node:assert"
import path from "node:path"

// Must be the first import that transitively touches vscode — in tsx/cjs,
// imports emit as sequential require() calls, so this stub runs first and
// intercepts require('vscode') before enrichResults loads.
import { vscodeMock } from "./vscode-stub"
import { enrichResults } from "./enrichResults"
import type { FileIconFont, FileResult, SearchResults } from "./types"
import type { FileIconResolver } from "./fileIconResolver"

const ROOT = "/workspace"
const webview = {} as never

function makeMatch(file: string) {
	return {
		id: -1,
		file,
		relativePath: file,
		line: 1,
		column: 0,
		lineText: "text",
		matchStart: 0,
		matchEnd: 4,
		contextBefore: [],
		contextAfter: [],
		breadcrumb: "",
	}
}

function fileResult(file: string, matchCount = 1): FileResult {
	return {
		file,
		relativePath: file,
		directory: "",
		fileName: path.basename(file),
		matches: Array.from({ length: matchCount }, () => makeMatch(file)),
	}
}

function makeResults(...files: FileResult[]): SearchResults {
	return {
		queryId: "q1",
		total: files.reduce((s, f) => s + f.matches.length, 0),
		truncated: false,
		fileResults: files,
	}
}

function makeResolver(opts: {
	uri?: string | null
	font?: FileIconFont | null
} = {}): FileIconResolver {
	return {
		resolveWebviewUri: () => opts.uri ?? null,
		resolveIconFont: () => opts.font ?? null,
	} as unknown as FileIconResolver
}

beforeEach(() => {
	vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: ROOT } }]
	vscodeMock.workspace.asRelativePath = (p: string) => path.relative(ROOT, p)
})

describe("enrichResults — path normalization", () => {
	it("sets relativePath, directory, and fileName for a nested file", () => {
		const r = makeResults(fileResult(`${ROOT}/src/utils/helper.ts`))
		enrichResults(r, makeResolver(), webview)
		const f = r.fileResults[0]
		assert.strictEqual(f.relativePath, "src/utils/helper.ts")
		assert.strictEqual(f.directory, "src/utils")
		assert.strictEqual(f.fileName, "helper.ts")
	})

	it("sets empty directory for files at the workspace root", () => {
		const r = makeResults(fileResult(`${ROOT}/readme.md`))
		enrichResults(r, makeResolver(), webview)
		assert.strictEqual(r.fileResults[0].directory, "")
	})

	it("propagates relativePath to each match", () => {
		const r = makeResults(fileResult(`${ROOT}/src/a.ts`, 2))
		enrichResults(r, makeResolver(), webview)
		const { relativePath, matches } = r.fileResults[0]
		for (const m of matches) {
			assert.strictEqual(m.relativePath, relativePath)
		}
	})

	it("skips normalization when no workspace folder is open", () => {
		vscodeMock.workspace.workspaceFolders = undefined
		const f = fileResult("/abs/path/file.ts")
		const original = f.relativePath
		enrichResults(makeResults(f), makeResolver(), webview)
		assert.strictEqual(f.relativePath, original)
	})
})

describe("enrichResults — sorting", () => {
	it("sorts fileResults alphabetically by relativePath", () => {
		const r = makeResults(
			fileResult(`${ROOT}/z.ts`),
			fileResult(`${ROOT}/a.ts`),
			fileResult(`${ROOT}/m.ts`),
		)
		enrichResults(r, makeResolver(), webview)
		assert.deepStrictEqual(
			r.fileResults.map((f) => f.fileName),
			["a.ts", "m.ts", "z.ts"],
		)
	})

	it("sorts across directories so shallower paths sort before deeper ones", () => {
		const r = makeResults(
			fileResult(`${ROOT}/src/z/deep.ts`),
			fileResult(`${ROOT}/src/a.ts`),
		)
		enrichResults(r, makeResolver(), webview)
		assert.deepStrictEqual(
			r.fileResults.map((f) => f.relativePath),
			["src/a.ts", "src/z/deep.ts"],
		)
	})
})

describe("enrichResults — match ID assignment", () => {
	it("assigns sequential IDs starting at 0 across all files and matches", () => {
		const r = makeResults(fileResult(`${ROOT}/a.ts`, 2), fileResult(`${ROOT}/b.ts`, 3))
		enrichResults(r, makeResolver(), webview)
		const ids = r.fileResults.flatMap((f) => f.matches.map((m) => m.id))
		assert.deepStrictEqual(ids, [0, 1, 2, 3, 4])
	})

	it("IDs follow sorted file order, not insertion order", () => {
		const r = makeResults(
			fileResult(`${ROOT}/b.ts`, 1),
			fileResult(`${ROOT}/a.ts`, 1),
		)
		enrichResults(r, makeResolver(), webview)
		const aFile = r.fileResults.find((f) => f.fileName === "a.ts")!
		const bFile = r.fileResults.find((f) => f.fileName === "b.ts")!
		assert.strictEqual(aFile.matches[0].id, 0)
		assert.strictEqual(bFile.matches[0].id, 1)
	})
})

describe("enrichResults — icon resolution", () => {
	it("sets iconUri when resolveWebviewUri returns a string", () => {
		const r = makeResults(fileResult(`${ROOT}/icon.ts`))
		enrichResults(r, makeResolver({ uri: "vscode-resource://icon.svg" }), webview)
		assert.strictEqual(r.fileResults[0].iconUri, "vscode-resource://icon.svg")
		assert.strictEqual(r.fileResults[0].iconFont, undefined)
	})

	it("sets iconFont when resolveWebviewUri returns null and resolveIconFont returns a font", () => {
		const font: FileIconFont = { family: "codicon", char: "", color: "#aaa" }
		const r = makeResults(fileResult(`${ROOT}/lib.rs`))
		enrichResults(r, makeResolver({ uri: null, font }), webview)
		assert.deepStrictEqual(r.fileResults[0].iconFont, font)
		assert.strictEqual(r.fileResults[0].iconUri, undefined)
	})

	it("sets neither when both resolvers return null", () => {
		const r = makeResults(fileResult(`${ROOT}/unknown.xyz`))
		enrichResults(r, makeResolver({ uri: null, font: null }), webview)
		assert.strictEqual(r.fileResults[0].iconUri, undefined)
		assert.strictEqual(r.fileResults[0].iconFont, undefined)
	})
})
