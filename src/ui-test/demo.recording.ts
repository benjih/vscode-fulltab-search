import * as fs from "node:fs"
import * as path from "node:path"
import {
	By,
	EditorView,
	Key,
	VSBrowser,
	type WebElement,
	WebView,
	Workbench,
} from "vscode-extension-tester"
import {
	dismissBlockingDialogs,
	ensureFixtureWorkspaceOpen,
	openFullTabSearchPanel,
	waitForStatus,
} from "./uiTestHelpers"

// Not a test: a scripted demo run that captures screenshots for the README
// gif. Excluded from `make test-ui` by its filename (no `.ui.test` suffix);
// run it with `make demo-gif`.

const DEMO_WORKSPACE = path.resolve(__dirname, "../../.demo-tmp")
const FRAMES_DIR = path.resolve(__dirname, "../../.demo-frames")

const DEMO_QUERY = "fetchJson"
const EDIT_TARGET_SNIPPET = "retries: 3"
const EDIT_APPEND_TEXT = " // the posts API is flaky"

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

// Captures full-window screenshots on an interval, in parallel with the
// scripted flow. Filenames carry capture timestamps so the gif builder can
// reproduce real pacing with per-frame delays.
class FrameRecorder {
	private running = false
	private frame = 0
	private loop: Promise<void> = Promise.resolve()

	start(intervalMs: number): void {
		this.running = true
		this.loop = (async () => {
			while (this.running) {
				try {
					const png = await VSBrowser.instance.driver.takeScreenshot()
					const name = `${String(this.frame).padStart(4, "0")}-${Date.now()}.png`
					fs.writeFileSync(path.join(FRAMES_DIR, name), png, "base64")
					this.frame++
				} catch {
					// Window busy (e.g. mid-navigation); skip this frame.
				}
				await pause(intervalMs)
			}
		})()
	}

	async stop(): Promise<number> {
		this.running = false
		await this.loop
		return this.frame
	}
}

async function typeSlowly(
	element: WebElement,
	text: string,
	delayMs: number,
): Promise<void> {
	for (const char of text) {
		await element.sendKeys(char)
		await pause(delayMs)
	}
}

async function findEditTarget(view: WebView): Promise<WebElement> {
	const lines = await view.findWebElements(By.css(".match-block .line-content"))
	for (const line of lines) {
		if ((await line.getText()).includes(EDIT_TARGET_SNIPPET)) {
			return line
		}
	}
	throw new Error(`No rendered line contains "${EDIT_TARGET_SNIPPET}"`)
}

describe("FullTab Search demo recording", () => {
	let view: WebView
	const recorder = new FrameRecorder()

	before(async function () {
		this.timeout(120_000)
		fs.mkdirSync(FRAMES_DIR, { recursive: true })
		await ensureFixtureWorkspaceOpen(DEMO_WORKSPACE)
		await openFullTabSearchPanel()
		view = new WebView()
		await view.switchToFrame()
	})

	after(async function () {
		this.timeout(30_000)
		await recorder.stop()
		try {
			if (view) {
				await view.switchBack()
			}
			await dismissBlockingDialogs()
			await new EditorView().closeAllEditors()
		} catch {
			// Cleanup is best-effort: a leftover dialog or dirty editor must
			// not fail the run after the frames are already captured.
		}
	})

	it("records the demo flow", async function () {
		this.timeout(180_000)
		recorder.start(40)

		// Splash screen.
		await pause(1000)

		// Search: type the query naturally, then run it.
		const input = await view.findWebElement(By.id("patternInput"))
		await input.click()
		await typeSlowly(input, DEMO_QUERY, 70)
		await pause(400)
		await input.sendKeys(Key.ENTER)
		await waitForStatus(view, (text) => /\d+ results/.test(text), 30_000)
		await pause(1500)

		// Navigate between matches.
		for (let i = 0; i < 3; i++) {
			await input.sendKeys(Key.F4)
			await pause(700)
		}
		await pause(600)

		// Edit mode: append a comment to a result line.
		const editToggle = await view.findWebElement(By.id("editToggle"))
		await editToggle.click()
		await pause(800)

		const line = await findEditTarget(view)
		await line.click()
		await pause(400)
		await line.sendKeys(Key.END)
		await pause(300)
		await typeSlowly(line, EDIT_APPEND_TEXT, 45)
		await pause(700)

		// Save the pending edits to disk. Chromedriver key synthesis for
		// Cmd/Ctrl chords is unreliable on macOS, so try a cascade and log
		// which path worked.
		const editedFile = path.join(DEMO_WORKSPACE, "src", "posts.ts")
		const editLanded = async (timeoutMs: number): Promise<boolean> => {
			const deadline = Date.now() + timeoutMs
			while (Date.now() < deadline) {
				if (fs.readFileSync(editedFile, "utf8").includes(EDIT_APPEND_TEXT)) {
					return true
				}
				await pause(250)
			}
			return false
		}

		const driver = view.getDriver()
		await driver
			.actions()
			.keyDown(Key.CONTROL)
			.sendKeys("s")
			.keyUp(Key.CONTROL)
			.perform()
		let saved = await editLanded(3000)
		if (saved) {
			console.log("save path: actions ctrl+s")
		} else {
			const probe = await driver.executeScript(
				`const ev = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true });
				const notCanceled = document.dispatchEvent(ev);
				return { canceled: !notCanceled, hasInput: !!document.getElementById("patternInput") }`,
			)
			console.log(`save path: js dispatch, probe=${JSON.stringify(probe)}`)
			saved = await editLanded(3000)
		}
		if (!saved) {
			await view.switchBack()
			await new Workbench().executeCommand("File: Save All")
			await view.switchToFrame()
			console.log("save path: workbench Save All")
			saved = await editLanded(5000)
		}
		if (!saved) {
			throw new Error("Saved edit never reached disk")
		}
		await pause(1500)

		const frames = await recorder.stop()
		if (frames < 10) {
			throw new Error(`Recorder captured only ${frames} frames`)
		}
	})
})
