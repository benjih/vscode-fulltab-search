import * as path from "node:path"
import {
	By,
	EditorView,
	InputBox,
	ModalDialog,
	type WebView,
	Workbench,
} from "vscode-extension-tester"

const FIXTURE_WORKSPACE = path.resolve(
	__dirname,
	"../../src/test/fixtures/sample-workspace",
)

export const OPEN_COMMAND = "FullTab Search: Open Project Search"

const DIALOG_CONFIRM_BUTTONS = [
	"Yes, I trust the authors",
	"Trust",
	"Open",
	"OK",
]

export async function dismissBlockingDialogs(): Promise<void> {
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			const dialog = new ModalDialog()
			const buttons = await dialog.getButtons()
			if (buttons.length === 0) {
				return
			}

			let clicked = false
			for (const title of DIALOG_CONFIRM_BUTTONS) {
				await dialog.pushButton(title)
				await new Promise((resolve) => setTimeout(resolve, 300))
				const remaining = await dialog.getButtons().catch(() => [])
				if (remaining.length === 0) {
					clicked = true
					break
				}
			}

			if (!clicked) {
				return
			}
		} catch {
			return
		}
	}
}

export async function ensureFixtureWorkspaceOpen(): Promise<void> {
	await dismissBlockingDialogs()

	try {
		const input = await InputBox.create()
		await input.setText(FIXTURE_WORKSPACE)
		await input.confirm()
		await new Promise((resolve) => setTimeout(resolve, 2000))
		await dismissBlockingDialogs()
		return
	} catch {
		// Input box not open yet; fall through to command palette flow.
	}

	const workbench = new Workbench()
	for (const command of ["Open Folder", "File: Open Folder"]) {
		try {
			await workbench.executeCommand(command)
			const input = await InputBox.create()
			await input.setText(FIXTURE_WORKSPACE)
			await input.confirm()
			await new Promise((resolve) => setTimeout(resolve, 2000))
			await dismissBlockingDialogs()
			return
		} catch {
			// try next command title
		}
	}

	throw new Error(`Failed to open fixture workspace at ${FIXTURE_WORKSPACE}`)
}

export async function openFullTabSearchPanel(
	timeoutMs = 30_000,
): Promise<void> {
	const editorView = new EditorView()
	const deadline = Date.now() + timeoutMs

	await dismissBlockingDialogs()
	await new Promise((resolve) => setTimeout(resolve, 2000))

	while (Date.now() < deadline) {
		await dismissBlockingDialogs()
		await new Workbench().executeCommand(OPEN_COMMAND)
		await new Promise((resolve) => setTimeout(resolve, 1500))
		const titles = await editorView.getOpenEditorTitles()
		if (titles.includes("FullTab Search")) {
			return
		}
	}

	const titles = await editorView.getOpenEditorTitles()
	throw new Error(
		`FullTab Search panel did not open. Open editors: ${titles.join(", ")}`,
	)
}

export async function waitForStatus(
	view: WebView,
	predicate: (text: string) => boolean,
	timeoutMs = 20_000,
): Promise<string> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const bar = await view.findWebElement(By.id("statusBar"))
		const text = await bar.getText()
		if (predicate(text)) {
			return text
		}
		await new Promise((resolve) => setTimeout(resolve, 200))
	}
	const bar = await view.findWebElement(By.id("statusBar"))
	const last = await bar.getText()
	throw new Error(
		`Timed out waiting for status bar update. Last status: "${last}"`,
	)
}

export async function setPatternAndSearch(
	view: WebView,
	pattern: string,
): Promise<void> {
	const input = await view.findWebElement(By.id("patternInput"))
	await input.clear()
	await input.sendKeys(pattern)
	// Debounced search in the webview (250ms); avoid Enter which can behave differently in WebDriver.
	await new Promise((resolve) => setTimeout(resolve, 600))
}
