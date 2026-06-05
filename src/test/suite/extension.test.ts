import * as assert from "node:assert"
import * as vscode from "vscode"
import { waitForWebviewPanel } from "./testHelpers"

suite("Extension Test Suite", () => {
	test("FullTab Search command opens webview panel", async function () {
		this.timeout(10_000)
		await vscode.commands.executeCommand("fullTabSearch.open")
		assert.ok(
			await waitForWebviewPanel("fullTabSearch.panel"),
			"Expected FullTab Search webview panel to be open",
		)
	})
})
