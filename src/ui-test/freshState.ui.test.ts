import * as assert from "node:assert"
import { By, EditorView, WebView } from "vscode-extension-tester"
import { MARKER } from "../test/fixtureConstants"
import {
	dismissBlockingDialogs,
	ensureFixtureWorkspaceOpen,
	openFullTabSearchPanel,
	setPatternAndSearch,
	waitForStatus,
} from "./uiTestHelpers"

describe("FullTab Search — fresh panel state", () => {
	let view: WebView

	before(async function () {
		this.timeout(120_000)
		await ensureFixtureWorkspaceOpen()

		// Open the panel and run a search so that globalState has a saved pattern.
		await openFullTabSearchPanel()
		const firstView = new WebView()
		await firstView.switchToFrame()
		await setPatternAndSearch(firstView, MARKER)
		await waitForStatus(firstView, (text) => text.includes("results"), 35_000)
		await firstView.switchBack()

		// Close and reopen to simulate opening a fresh tab.
		await new EditorView().closeAllEditors()
		await openFullTabSearchPanel()
		view = new WebView()
		await view.switchToFrame()
	})

	after(async function () {
		this.timeout(30_000)
		if (view) {
			await view.switchBack()
		}
		await dismissBlockingDialogs()
		await new EditorView().closeAllEditors()
	})

	it("opens with all text fields empty", async () => {
		const patternInput = await view.findWebElement(By.id("patternInput"))
		const replaceInput = await view.findWebElement(By.id("replaceInput"))
		const includeInput = await view.findWebElement(By.id("includeInput"))
		const excludeInput = await view.findWebElement(By.id("excludeInput"))

		assert.strictEqual(await patternInput.getAttribute("value"), "")
		assert.strictEqual(await replaceInput.getAttribute("value"), "")
		assert.strictEqual(await includeInput.getAttribute("value"), "")
		assert.strictEqual(await excludeInput.getAttribute("value"), "")
	})

	it("shows the splash screen rather than re-running the last search", async () => {
		const splash = await view.findWebElement(By.css(".splash"))
		assert.ok((await splash.getText()).includes("Search your workspace"))
	})
})
