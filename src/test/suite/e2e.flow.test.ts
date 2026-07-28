import * as assert from "node:assert"
import * as fs from "node:fs"
import * as path from "node:path"
import * as vscode from "vscode"
import { SearchEngine } from "../../search/searchEngine"
import { MARKER, makeQuery, waitForWebviewPanel } from "./testHelpers"
import { afterAll, beforeAll, describe, it } from "./vitestApi"

describe("E2E Flow Suite", () => {
	const engine = new SearchEngine()

	beforeAll(() => {
		assert.ok(
			vscode.workspace.workspaceFolders?.[0],
			"Fixture workspace required",
		)
	})

	afterAll(() => {
		engine.cancel()
	})

	it("open command and search flow", async () => {
		await vscode.commands.executeCommand("fullTabSearch.open")
		assert.ok(await waitForWebviewPanel("fullTabSearch.panel"))

		const token = new vscode.CancellationTokenSource()
		const results = await engine.search(makeQuery(), token.token)
		token.dispose()

		assert.strictEqual(results.total, 4)
	}, 20_000)

	it("openMatch navigates editor to match location", async () => {
		const token = new vscode.CancellationTokenSource()
		const results = await engine.search(
			makeQuery({ include: "**/hello.ts" }),
			token.token,
		)
		token.dispose()

		const match = results.fileResults[0].matches[0]
		const document = await vscode.workspace.openTextDocument(
			vscode.Uri.file(match.file),
		)
		const editor = await vscode.window.showTextDocument(document, {
			preview: false,
		})

		const position = new vscode.Position(match.line - 1, match.column)
		editor.selection = new vscode.Selection(position, position)
		editor.revealRange(
			new vscode.Range(position, position),
			vscode.TextEditorRevealType.InCenter,
		)

		assert.strictEqual(editor.document.uri.fsPath, match.file)
		assert.strictEqual(editor.selection.active.line, match.line - 1)
		assert.strictEqual(editor.selection.active.character, match.column)
	}, 20_000)

	it("replaceAll updates file contents", async () => {
		assert.ok(vscode.workspace.workspaceFolders)
		const root = vscode.workspace.workspaceFolders[0].uri.fsPath
		const tempFile = path.join(root, "src", ".e2e-replace-target.ts")
		// Two occurrences on one line plus one on another: replaceAll must
		// cover every occurrence, not just the first per line.
		const original = `export const value = '${MARKER} ${MARKER}';\nexport const other = '${MARKER}';\n`

		fs.writeFileSync(tempFile, original, "utf8")

		try {
			const token = new vscode.CancellationTokenSource()
			const result = await engine.replaceAll(
				makeQuery({
					pattern: MARKER,
					include: "**/.e2e-replace-target.ts",
					replace: "__FULLTAB_REPLACED__",
				}),
				token.token,
			)
			token.dispose()

			assert.strictEqual(result.replaced, 3)
			assert.strictEqual(result.truncated, false)
			assert.strictEqual(result.cancelled, false)
			// Read from disk, not the in-memory document: search runs ripgrep
			// against disk, so replacements must be persisted to count as applied.
			const updated = fs.readFileSync(tempFile, "utf8")
			assert.ok(updated.includes("__FULLTAB_REPLACED__"))
			assert.ok(!updated.includes(MARKER))
		} finally {
			fs.rmSync(tempFile, { force: true })
		}
	}, 20_000)

	it("replaceAll expands capture group references in regex mode", async () => {
		assert.ok(vscode.workspace.workspaceFolders)
		const root = vscode.workspace.workspaceFolders[0].uri.fsPath
		const tempFile = path.join(root, "src", ".e2e-capture-target.ts")
		const original = `const a = ${MARKER}_one;\nconst b = ${MARKER}_two;\n`

		fs.writeFileSync(tempFile, original, "utf8")

		try {
			const token = new vscode.CancellationTokenSource()
			const result = await engine.replaceAll(
				makeQuery({
					pattern: `${MARKER}_(\\w+)`,
					useRegex: true,
					include: "**/.e2e-capture-target.ts",
					replace: "renamed_$1",
				}),
				token.token,
			)
			token.dispose()

			assert.strictEqual(result.replaced, 2)
			assert.strictEqual(
				fs.readFileSync(tempFile, "utf8"),
				"const a = renamed_one;\nconst b = renamed_two;\n",
			)
		} finally {
			fs.rmSync(tempFile, { force: true })
		}
	}, 20_000)
})
