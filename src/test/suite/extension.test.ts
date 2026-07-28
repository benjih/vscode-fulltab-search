import * as assert from "node:assert"
import * as vscode from "vscode"
import { waitForWebviewPanel } from "./testHelpers"
import { describe, it } from "./vitestApi"

describe("Extension Test Suite", () => {
	it("FullTab Search command opens webview panel", async () => {
		await vscode.commands.executeCommand("fullTabSearch.open")
		assert.ok(
			await waitForWebviewPanel("fullTabSearch.panel"),
			"Expected FullTab Search webview panel to be open",
		)
	}, 10_000)
})
