import * as assert from "node:assert"
import * as fs from "node:fs"
import * as path from "node:path"
import * as vscode from "vscode"
import {
	applyLineEdit,
	applyLineJoin,
	applyLineSplit,
} from "../../search/lineEdits"
import { saveEditedDocuments } from "../../search/searchEngine"

suite("Line Edits Suite", () => {
	let counter = 0
	const tempFiles: string[] = []

	function workspaceRoot(): string {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		assert.ok(root, "Fixture workspace required")
		return root
	}

	function createTempFile(content: string): string {
		const file = path.join(
			workspaceRoot(),
			"src",
			`.lineedits-${++counter}.txt`,
		)
		fs.writeFileSync(file, content, "utf8")
		tempFiles.push(file)
		return file
	}

	suiteTeardown(async () => {
		// Flush dirty documents before deleting so no unsaved buffers linger.
		await saveEditedDocuments(tempFiles.map((f) => vscode.Uri.file(f)))
		for (const file of tempFiles) {
			fs.rmSync(file, { force: true })
		}
	})

	test("applyLineEdit replaces the line in the buffer, not on disk", async () => {
		const file = createTempFile("alpha\nbravo\ncharlie\n")

		const uri = await applyLineEdit(file, 2, "BRAVO EDITED")
		const document = await vscode.workspace.openTextDocument(uri)

		assert.strictEqual(
			document.getText(),
			"alpha\nBRAVO EDITED\ncharlie\n",
			"document buffer reflects the edit",
		)
		assert.ok(document.isDirty, "document stays dirty until an explicit save")
		assert.strictEqual(
			fs.readFileSync(file, "utf8"),
			"alpha\nbravo\ncharlie\n",
			"disk is untouched until save",
		)
	})

	test("saveEditedDocuments persists pending edits to disk", async () => {
		const file = createTempFile("alpha\nbravo\n")

		const uri = await applyLineEdit(file, 1, "ALPHA EDITED")
		await saveEditedDocuments([uri])

		const document = await vscode.workspace.openTextDocument(uri)
		assert.ok(!document.isDirty, "document is clean after save")
		assert.strictEqual(fs.readFileSync(file, "utf8"), "ALPHA EDITED\nbravo\n")
	})

	test("applyLineSplit inserts a line break at the caret position", async () => {
		const file = createTempFile("const value = 1\nsecond\n")

		const uri = await applyLineSplit(file, 1, "const ", "value = 1")
		const document = await vscode.workspace.openTextDocument(uri)

		assert.strictEqual(document.getText(), "const \nvalue = 1\nsecond\n")
		assert.strictEqual(document.lineCount, 4)
	})

	test("applyLineSplit preserves CRLF line endings", async () => {
		const file = createTempFile("alpha\r\nbravo\r\n")

		const uri = await applyLineSplit(file, 1, "al", "pha")
		const document = await vscode.workspace.openTextDocument(uri)

		assert.strictEqual(document.eol, vscode.EndOfLine.CRLF)
		assert.strictEqual(document.getText(), "al\r\npha\r\nbravo\r\n")
	})

	test("applyLineJoin merges a line into the previous one", async () => {
		const file = createTempFile("first\nsecond\nthird\n")

		const uri = await applyLineJoin(file, 2, "firstsecond")
		assert.ok(uri, "join above line 1 is applied")
		const document = await vscode.workspace.openTextDocument(uri)

		assert.strictEqual(document.getText(), "firstsecond\nthird\n")
	})

	test("applyLineJoin merges uncommitted typing from the caller", async () => {
		// The webview computes mergedContent from its DOM, which may contain
		// typing never applied to the document — the join must win over the
		// stale document text.
		const file = createTempFile("first\nsecond\n")

		const uri = await applyLineJoin(file, 2, "firstSECOND TYPED")
		assert.ok(uri)
		const document = await vscode.workspace.openTextDocument(uri)

		assert.strictEqual(document.getText(), "firstSECOND TYPED\n")
	})

	test("applyLineJoin on the first line is a no-op", async () => {
		const file = createTempFile("first\nsecond\n")

		const uri = await applyLineJoin(file, 1, "whatever")
		assert.strictEqual(uri, null)

		const document = await vscode.workspace.openTextDocument(
			vscode.Uri.file(file),
		)
		assert.strictEqual(document.getText(), "first\nsecond\n")
	})

	test("edit, split, join sequence then save matches the final state", async () => {
		const file = createTempFile("one\ntwo\nthree\n")

		// Edit line 2, split it, then join the split back together.
		await applyLineEdit(file, 2, "two edited")
		await applyLineSplit(file, 2, "two ", "edited")
		const uri = await applyLineJoin(file, 3, "two edited")
		assert.ok(uri)
		await saveEditedDocuments([uri])

		assert.strictEqual(
			fs.readFileSync(file, "utf8"),
			"one\ntwo edited\nthree\n",
		)
	})
})
