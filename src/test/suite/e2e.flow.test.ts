import * as assert from "node:assert"
import * as fs from "node:fs"
import * as path from "node:path"
import * as vscode from "vscode"
import { SearchEngine } from "../../search/searchEngine"
import { MARKER, makeQuery, waitForWebviewPanel } from "./testHelpers"

suite("E2E Flow Suite", () => {
	const engine = new SearchEngine()

	suiteSetup(() => {
		assert.ok(
			vscode.workspace.workspaceFolders?.[0],
			"Fixture workspace required",
		)
	})

	suiteTeardown(() => {
		engine.cancel()
	})

	test("open command and search flow", async function () {
		this.timeout(20_000)

		await vscode.commands.executeCommand("fullTabSearch.open")
		assert.ok(await waitForWebviewPanel("fullTabSearch.panel"))

		const token = new vscode.CancellationTokenSource()
		const results = await engine.search(makeQuery(), token.token)
		token.dispose()

		assert.strictEqual(results.total, 2)
	})

	test("openMatch navigates editor to match location", async function () {
		this.timeout(20_000)

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
	})

	test("replaceAll updates file contents", async function () {
		this.timeout(20_000)

		assert.ok(vscode.workspace.workspaceFolders)
		const root = vscode.workspace.workspaceFolders[0].uri.fsPath
		const tempFile = path.join(root, "src", ".e2e-replace-target.ts")
		const original = `export const value = '${MARKER}';\n`

		fs.writeFileSync(tempFile, original, "utf8")

		try {
			const token = new vscode.CancellationTokenSource()
			const count = await engine.replaceAll(
				makeQuery({
					pattern: MARKER,
					include: "**/.e2e-replace-target.ts",
					replace: "__FULLTAB_REPLACED__",
				}),
				token.token,
			)
			token.dispose()

			assert.strictEqual(count, 1)
			const document = await vscode.workspace.openTextDocument(
				vscode.Uri.file(tempFile),
			)
			const updated = document.getText()
			assert.ok(updated.includes("__FULLTAB_REPLACED__"))
			assert.ok(!updated.includes(MARKER))
		} finally {
			fs.rmSync(tempFile, { force: true })
		}
	})
})
