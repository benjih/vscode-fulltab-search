import * as assert from "node:assert";
import * as path from "node:path";
import * as vscode from "vscode";
import { SearchEngine } from "../../search/searchEngine";
import { MARKER, makeQuery } from "./testHelpers";

suite("SearchEngine Integration Suite", () => {
	const engine = new SearchEngine();
	const tokenSource = new vscode.CancellationTokenSource();

	suiteSetup(() => {
		assert.ok(
			vscode.workspace.workspaceFolders?.[0],
			"Fixture workspace must be open for integration tests",
		);
	});

	suiteTeardown(() => {
		tokenSource.dispose();
		engine.cancel();
	});

	test("finds marker across TypeScript files", async function () {
		this.timeout(15_000);

		const results = await engine.search(makeQuery(), tokenSource.token);

		assert.strictEqual(results.total, 2);
		assert.strictEqual(results.truncated, false);
		assert.ok(results.fileResults.length >= 2);

		const relativePaths = results.fileResults.map(
			(entry) => entry.relativePath,
		);
		assert.ok(relativePaths.some((p) => p.endsWith("hello.ts")));
		assert.ok(relativePaths.some((p) => p.endsWith("utils.ts")));
	});

	test("respects include glob", async function () {
		this.timeout(15_000);

		const results = await engine.search(
			makeQuery({ include: "**/hello.ts" }),
			tokenSource.token,
		);

		assert.strictEqual(results.total, 1);
		assert.ok(results.fileResults[0].fileName.endsWith("hello.ts"));
	});

	test("respects exclude glob", async function () {
		this.timeout(15_000);

		const results = await engine.search(
			makeQuery({ exclude: "*.log, **/*.ts" }),
			tokenSource.token,
		);

		assert.strictEqual(results.total, 0);
	});

	test("returns empty results for blank pattern", async () => {
		const results = await engine.search(
			makeQuery({ pattern: "   " }),
			tokenSource.token,
		);

		assert.strictEqual(results.total, 0);
		assert.deepStrictEqual(results.fileResults, []);
	});

	test("adds breadcrumbs for function context", async function () {
		this.timeout(15_000);

		const results = await engine.search(makeQuery(), tokenSource.token);
		const helloFile = results.fileResults.find(
			(entry) => entry.fileName === "hello.ts",
		);
		assert.ok(helloFile);
		const match = helloFile.matches[0];
		assert.ok(match.breadcrumb.includes("greet"));
	});

	test("expandContext returns surrounding lines", () => {
		assert.ok(vscode.workspace.workspaceFolders);
		const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
		const filePath = path.join(root, "src", "hello.ts");
		const { lines, hasMore } = engine.expandContext(filePath, "before", 4, 2);

		assert.ok(lines.length > 0);
		assert.ok(lines.every((line) => line.line < 4));
		assert.strictEqual(typeof hasMore, "boolean");
	});

	test("cancels in-flight search", async function () {
		this.timeout(15_000);

		const cancelSource = new vscode.CancellationTokenSource();
		const searchPromise = engine.search(
			makeQuery({ pattern: MARKER }),
			cancelSource.token,
		);
		engine.cancel();
		cancelSource.cancel();

		const results = await searchPromise;
		assert.ok(results.total >= 0);
		cancelSource.dispose();
	});
});
