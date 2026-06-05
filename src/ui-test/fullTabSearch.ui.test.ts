import { expect } from "chai";
import { By, EditorView, WebView } from "vscode-extension-tester";
import { MARKER } from "../test/fixtureConstants";
import {
	dismissBlockingDialogs,
	ensureFixtureWorkspaceOpen,
	openFullTabSearchPanel,
	setPatternAndSearch,
	waitForStatus,
} from "./uiTestHelpers";

function resultCountFromStatus(status: string): number {
	const match = status.match(/(\d+)\+? results/);
	return match ? Number(match[1]) : 0;
}

describe("FullTab Search UI E2E", () => {
	let view: WebView;

	before(async function () {
		this.timeout(90_000);
		await ensureFixtureWorkspaceOpen();
		await openFullTabSearchPanel();

		view = new WebView();
		await view.switchToFrame();
	});

	after(async function () {
		this.timeout(30_000);
		if (view) {
			await view.switchBack();
		}
		await dismissBlockingDialogs();
		await new EditorView().closeAllEditors();
	});

	it("shows empty state before searching", async () => {
		const empty = await view.findWebElement(By.css(".empty-state"));
		expect(await empty.getText()).to.include("Enter a search query");
	});

	it("runs search from the pattern input and lists fixture files", async function () {
		this.timeout(45_000);
		await setPatternAndSearch(view, MARKER);

		const status = await waitForStatus(
			view,
			(text) => resultCountFromStatus(text) >= 2,
			35_000,
		);
		expect(resultCountFromStatus(status)).to.be.greaterThanOrEqual(2);

		const counter = await view.findWebElement(By.id("matchCounter"));
		expect(await counter.getText()).to.match(/^1\/\d+$/);

		const fileNames = await view.findWebElements(By.css(".file-name"));
		const names = await Promise.all(
			fileNames.map((element) => element.getText()),
		);
		expect(names).to.include("hello.ts");
		expect(names).to.include("utils.ts");
	});

	it("shows no results for a non-matching query", async function () {
		this.timeout(30_000);
		await setPatternAndSearch(view, "__no_such_fixture_match__");

		const status = await waitForStatus(view, (text) =>
			text.includes("0 results"),
		);
		expect(status).to.equal("0 results in 0 files");

		const empty = await view.findWebElement(By.css(".empty-state"));
		expect(await empty.getText()).to.equal("No results found");
	});

	it("toggles match case from the webview toolbar", async function () {
		this.timeout(45_000);
		await setPatternAndSearch(view, MARKER);
		await waitForStatus(
			view,
			(text) => resultCountFromStatus(text) >= 2,
			35_000,
		);

		const caseToggle = await view.findWebElement(By.id("caseToggle"));
		await caseToggle.click();
		await setPatternAndSearch(view, "fulltab_fixture_marker");

		const caseStatus = await waitForStatus(
			view,
			(text) => text.includes("0 results"),
			35_000,
		);
		expect(caseStatus).to.equal("0 results in 0 files");
	});
});
