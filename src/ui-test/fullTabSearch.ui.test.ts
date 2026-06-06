import * as assert from "node:assert"
import { By, EditorView, WebView } from "vscode-extension-tester"
import { MARKER } from "../test/fixtureConstants"
import { clearPerfMetricsFile, waitForPerfMetric } from "../test/perfHelpers"
import {
	dismissBlockingDialogs,
	ensureFixtureWorkspaceOpen,
	openFullTabSearchPanel,
	setPatternAndSearch,
	waitForStatus,
} from "./uiTestHelpers"

const RUN_SEARCH_BUDGET_MS = 2_000

function resultCountFromStatus(status: string): number {
	const match = status.match(/(\d+)\+? results/)
	return match ? Number(match[1]) : 0
}

describe("FullTab Search UI E2E", () => {
	let view: WebView

	before(async function () {
		this.timeout(90_000)
		clearPerfMetricsFile()
		await ensureFixtureWorkspaceOpen()
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

	it("shows empty state before searching", async () => {
		const empty = await view.findWebElement(By.css(".empty-state"))
		assert.ok((await empty.getText()).includes("Enter a search query"))
	})

	it("runs search from the pattern input and lists fixture files", async function () {
		this.timeout(45_000)
		await setPatternAndSearch(view, MARKER)

		const status = await waitForStatus(
			view,
			(text) => resultCountFromStatus(text) >= 2,
			35_000,
		)
		assert.ok(resultCountFromStatus(status) >= 2)

		const counter = await view.findWebElement(By.id("matchCounter"))
		assert.match(await counter.getText(), /^1\/\d+$/)

		const fileNames = await view.findWebElements(By.css(".file-name"))
		const names = await Promise.all(
			fileNames.map((element) => element.getText()),
		)
		assert.ok(names.includes("hello.ts"))
		assert.ok(names.includes("utils.ts"))
	})

	it("shows no results for a non-matching query", async function () {
		this.timeout(30_000)
		await setPatternAndSearch(view, "__no_such_fixture_match__")

		const status = await waitForStatus(view, (text) =>
			text.includes("0 results"),
		)
		assert.strictEqual(status, "0 results in 0 files")

		const empty = await view.findWebElement(By.css(".empty-state"))
		assert.strictEqual(await empty.getText(), "No results found")
	})

	it("toggles match case from the webview toolbar", async function () {
		this.timeout(45_000)
		await setPatternAndSearch(view, MARKER)
		await waitForStatus(
			view,
			(text) => resultCountFromStatus(text) >= 2,
			35_000,
		)

		const caseToggle = await view.findWebElement(By.id("caseToggle"))
		await caseToggle.click()
		await setPatternAndSearch(view, "fulltab_fixture_marker")

		const caseStatus = await waitForStatus(
			view,
			(text) => text.includes("0 results"),
			35_000,
		)
		assert.strictEqual(caseStatus, "0 results in 0 files")
	})

	it("records runSearch perf metrics to the test perf file", async function () {
		this.timeout(45_000)
		clearPerfMetricsFile()
		await setPatternAndSearch(view, MARKER)
		await waitForStatus(
			view,
			(text) => resultCountFromStatus(text) >= 2,
			35_000,
		)

		const runSearchMetric = await waitForPerfMetric("runSearch", 10_000)
		assert.strictEqual(runSearchMetric.details?.query, MARKER)
		assert.ok(
			runSearchMetric.durationMs < RUN_SEARCH_BUDGET_MS,
			`runSearch took ${runSearchMetric.durationMs.toFixed(1)}ms (budget ${RUN_SEARCH_BUDGET_MS}ms)`,
		)
	})
})
