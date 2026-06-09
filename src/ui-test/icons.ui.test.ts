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

function resultCountFromStatus(status: string): number {
	const match = status.match(/(\d+)\+? results/)
	return match ? Number(match[1]) : 0
}

describe("FullTab Search — file icons", () => {
	let view: WebView

	before(async function () {
		this.timeout(90_000)
		await ensureFixtureWorkspaceOpen()
		await openFullTabSearchPanel()
		view = new WebView()
		await view.switchToFrame()
	})

	after(async function () {
		this.timeout(30_000)
		if (view) await view.switchBack()
		await dismissBlockingDialogs()
		await new EditorView().closeAllEditors()
	})

	it("renders a file icon for every result file", async function () {
		this.timeout(45_000)

		// Fixture includes hello.ts, utils.ts, marker.json, marker.md — all ≥4 files.
		await setPatternAndSearch(view, MARKER)
		await waitForStatus(view, (t) => resultCountFromStatus(t) >= 4, 35_000)

		const headers = await view.findWebElements(By.css(".file-header"))
		assert.ok(headers.length >= 4, `Expected ≥4 file headers, got ${headers.length}`)

		// Every header must have exactly one .file-icon child.
		for (const header of headers) {
			const icons = await header.findElements(By.css(".file-icon"))
			assert.strictEqual(icons.length, 1, "Each file header should have exactly one icon")
		}
	})

	it("uses theme-based icons rather than the generic codicon fallback", async function () {
		this.timeout(45_000)

		await setPatternAndSearch(view, MARKER)
		await waitForStatus(view, (t) => resultCountFromStatus(t) >= 4, 35_000)

		// When an icon theme is active the icons should be .file-icon-font (font-based,
		// e.g. Seti) or .file-icon-img (SVG-based, e.g. Material Icon Theme).
		// The plain codicon fallback (.codicon-file) should not appear.
		const fontIcons = await view.findWebElements(By.css(".file-icon-font"))
		const imgIcons = await view.findWebElements(By.css(".file-icon-img"))
		const themeIconCount = fontIcons.length + imgIcons.length

		const codicons = await view.findWebElements(By.css(".file-icon.codicon-file"))

		assert.ok(
			themeIconCount > 0,
			"Expected at least some theme-based icons (.file-icon-font or .file-icon-img)",
		)
		assert.strictEqual(
			codicons.length,
			0,
			`Expected no codicon fallback icons, but found ${codicons.length}`,
		)
	})

	it("shows different icons for different file types", async function () {
		this.timeout(45_000)

		await setPatternAndSearch(view, MARKER)
		await waitForStatus(view, (t) => resultCountFromStatus(t) >= 4, 35_000)

		// Font-based themes (e.g. Seti) set a per-type color directly on the span.
		// TypeScript (#519aba) and JSON (#cbcb41) have distinct colors in Seti.
		const fontIcons = await view.findWebElements(By.css(".file-icon-font"))
		if (fontIcons.length < 2) {
			// SVG-based theme active — icon diversity is expressed via src URL, skip color check.
			const imgIcons = await view.findWebElements(By.css(".file-icon-img"))
			const srcs = await Promise.all(imgIcons.map((el) => el.getAttribute("src")))
			const uniqueSrcs = new Set(srcs)
			assert.ok(
				uniqueSrcs.size >= 2,
				`Expected different icon images for different file types, but all src were the same`,
			)
			return
		}

		const colors = await Promise.all(
			fontIcons.map((el) => el.getCssValue("color")),
		)
		const uniqueColors = new Set(colors)
		assert.ok(
			uniqueColors.size >= 2,
			`All file icons have the same color (${[...uniqueColors][0]}), ` +
				`expected per-type variation across .ts, .json, and .md files`,
		)
	})
})
