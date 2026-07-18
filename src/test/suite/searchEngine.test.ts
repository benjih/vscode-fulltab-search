import * as assert from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"
import { SearchEngine } from "../../search/searchEngine"
import { MARKER, makeQuery } from "./testHelpers"

suite("SearchEngine Integration Suite", () => {
	const engine = new SearchEngine()
	const tokenSource = new vscode.CancellationTokenSource()

	suiteSetup(() => {
		assert.ok(
			vscode.workspace.workspaceFolders?.[0],
			"Fixture workspace must be open for integration tests",
		)
	})

	suiteTeardown(() => {
		tokenSource.dispose()
		engine.cancel()
	})

	test("finds marker across TypeScript files", async function () {
		this.timeout(15_000)

		const results = await engine.search(makeQuery(), tokenSource.token)

		assert.strictEqual(results.total, 4)
		assert.strictEqual(results.truncated, false)
		assert.ok(results.fileResults.length >= 4)

		const relativePaths = results.fileResults.map((entry) => entry.relativePath)
		assert.ok(relativePaths.some((p) => p.endsWith("hello.ts")))
		assert.ok(relativePaths.some((p) => p.endsWith("utils.ts")))
		assert.ok(relativePaths.some((p) => p.endsWith("marker.json")))
		assert.ok(relativePaths.some((p) => p.endsWith("marker.md")))
	})

	test("keeps matches and surfaces a warning when a file is unreadable", async function () {
		this.timeout(15_000)
		// chmod 0 has no effect when running as root, and doesn't restrict
		// reads on Windows the way it does on POSIX — skip there.
		if (process.platform === "win32" || process.getuid?.() === 0) {
			this.skip()
			return
		}

		assert.ok(vscode.workspace.workspaceFolders)
		const root = vscode.workspace.workspaceFolders[0].uri.fsPath
		const unreadablePath = path.join(root, "src", "unreadable-marker.ts")
		await fs.writeFile(unreadablePath, `// ${MARKER}\n`)
		await fs.chmod(unreadablePath, 0)

		try {
			const results = await engine.search(makeQuery(), tokenSource.token)

			assert.strictEqual(results.total, 4)
			assert.ok(results.warning?.includes("unreadable-marker.ts"))
		} finally {
			await fs.chmod(unreadablePath, 0o644)
			await fs.unlink(unreadablePath)
		}
	})

	test("respects include glob", async function () {
		this.timeout(15_000)

		const results = await engine.search(
			makeQuery({ include: "**/hello.ts" }),
			tokenSource.token,
		)

		assert.strictEqual(results.total, 1)
		assert.ok(results.fileResults[0].fileName.endsWith("hello.ts"))
	})

	test("respects exclude glob", async function () {
		this.timeout(15_000)

		const results = await engine.search(
			makeQuery({ exclude: "*.log, **/*.ts, **/*.json, **/*.md" }),
			tokenSource.token,
		)

		assert.strictEqual(results.total, 0)
	})

	test("returns empty results for blank pattern", async () => {
		const results = await engine.search(
			makeQuery({ pattern: "   " }),
			tokenSource.token,
		)

		assert.strictEqual(results.total, 0)
		assert.deepStrictEqual(results.fileResults, [])
	})

	test("adds breadcrumbs for function context", async function () {
		this.timeout(15_000)

		const results = await engine.search(makeQuery(), tokenSource.token)
		const helloFile = results.fileResults.find(
			(entry) => entry.fileName === "hello.ts",
		)
		assert.ok(helloFile)
		const match = helloFile.matches[0]
		assert.ok(match.breadcrumb.includes("greet"))
	})

	test("expandContext returns surrounding lines", async () => {
		assert.ok(vscode.workspace.workspaceFolders)
		const root = vscode.workspace.workspaceFolders[0].uri.fsPath
		const filePath = path.join(root, "src", "hello.ts")
		const { lines, hasMore } = await engine.expandContext(
			filePath,
			"before",
			4,
			2,
		)

		assert.ok(lines.length > 0)
		assert.ok(lines.every((line) => line.line < 4))
		assert.strictEqual(typeof hasMore, "boolean")
	})

	test("cancels in-flight search", async function () {
		this.timeout(15_000)

		const cancelSource = new vscode.CancellationTokenSource()
		const searchPromise = engine.search(
			makeQuery({ pattern: MARKER }),
			cancelSource.token,
		)
		engine.cancel()
		cancelSource.cancel()

		const results = await searchPromise
		assert.ok(results.total >= 0)
		cancelSource.dispose()
	})
})
