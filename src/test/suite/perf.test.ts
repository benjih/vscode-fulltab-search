import * as assert from "node:assert"
import * as vscode from "vscode"
import { findMetric, type RecordedMetric } from "../../debug/metrics"
import { SearchEngine } from "../../search/searchEngine"
import { makeQuery } from "./testHelpers"

const SEARCH_BUDGET_MS = 15_000

async function withDebugEnabled<T>(fn: () => Promise<T>): Promise<T> {
	const config = vscode.workspace.getConfiguration("fullTabSearch")
	const previous = config.get<boolean>("debug", false)
	await config.update("debug", true, vscode.ConfigurationTarget.Global)
	try {
		return await fn()
	} finally {
		await config.update("debug", previous, vscode.ConfigurationTarget.Global)
	}
}

suite("Performance Metrics Suite", () => {
	const engine = new SearchEngine()

	suiteSetup(() => {
		assert.ok(
			vscode.workspace.workspaceFolders?.[0],
			"Fixture workspace must be open for performance tests",
		)
	})

	suiteTeardown(() => {
		engine.cancel()
	})

	test("records search timings retrievable via test command", async function () {
		this.timeout(20_000)

		await withDebugEnabled(async () => {
			await vscode.commands.executeCommand("fullTabSearch.clearDebugMetrics")

			const token = new vscode.CancellationTokenSource()
			await engine.search(makeQuery(), token.token)
			token.dispose()

			const metrics = await vscode.commands.executeCommand<
				readonly RecordedMetric[]
			>("fullTabSearch.getDebugMetrics")
			assert.ok(metrics && metrics.length > 0)

			const searchMetric = findMetric(metrics, "search")
			assert.ok(
				searchMetric,
				`Expected search metric, got: ${metrics.map((m) => m.name).join(", ")}`,
			)
			assert.strictEqual(searchMetric.details?.query, makeQuery().pattern)
			assert.ok(
				searchMetric.durationMs < SEARCH_BUDGET_MS,
				`search took ${searchMetric.durationMs.toFixed(1)}ms (budget ${SEARCH_BUDGET_MS}ms)`,
			)

			const ripgrepMetric = findMetric(metrics, "search.ripgrep")
			assert.ok(ripgrepMetric)
			assert.ok(ripgrepMetric.durationMs <= searchMetric.durationMs)
		})
	})
})
