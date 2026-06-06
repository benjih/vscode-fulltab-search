import * as fs from "node:fs"
import * as path from "node:path"
import * as vscode from "vscode"

const CONFIG_SECTION = "fullTabSearch"
const OUTPUT_CHANNEL_NAME = "FullTab Search"

let outputChannel: vscode.OutputChannel | undefined
let extensionPath: string | undefined
const recordedMetrics: RecordedMetric[] = []

export interface RecordedMetric {
	name: string
	durationMs: number
	details?: MetricDetails
	timestamp: number
}

export function initDebugOutput(context: vscode.ExtensionContext): void {
	outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME)
	extensionPath = context.extensionPath
	context.subscriptions.push(outputChannel)
}

function isDebugEnabled(): boolean {
	return vscode.workspace
		.getConfiguration(CONFIG_SECTION)
		.get<boolean>("debug", false)
}

export type MetricDetails = Record<string, string | number | boolean>

export interface SearchMetricQuery {
	pattern: string
	include: string
	exclude: string
	caseSensitive?: boolean
	wholeWord?: boolean
	useRegex?: boolean
}

export function searchQueryDetails(query: SearchMetricQuery): MetricDetails {
	const details: MetricDetails = {
		query: query.pattern,
		include: query.include,
		exclude: query.exclude,
	}
	if (query.caseSensitive) {
		details.case = true
	}
	if (query.wholeWord) {
		details.word = true
	}
	if (query.useRegex) {
		details.regex = true
	}
	return details
}

export function getRecordedMetrics(): readonly RecordedMetric[] {
	return recordedMetrics
}

export function clearRecordedMetrics(): void {
	recordedMetrics.length = 0
	clearPerfMetricsFile()
}

export function findMetric(
	metrics: readonly RecordedMetric[],
	name: string,
): RecordedMetric | undefined {
	for (let i = metrics.length - 1; i >= 0; i--) {
		if (metrics[i].name === name) {
			return metrics[i]
		}
	}
	return undefined
}

function perfMetricsFilePath(): string | undefined {
	const configured = process.env.FULLTAB_PERF_FILE?.trim()
	if (configured) {
		if (path.isAbsolute(configured)) {
			return configured
		}
		const base = extensionPath ?? process.cwd()
		return path.resolve(base, configured)
	}

	const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
	if (!workspaceFolder) {
		return undefined
	}

	return path.join(workspaceFolder.uri.fsPath, ".fulltab-perf.ndjson")
}

function clearPerfMetricsFile(): void {
	const filePath = perfMetricsFilePath()
	if (!filePath) {
		return
	}
	fs.mkdirSync(path.dirname(filePath), { recursive: true })
	fs.writeFileSync(filePath, "", "utf8")
}

function appendPerfMetricFile(metric: RecordedMetric): void {
	const filePath = perfMetricsFilePath()
	if (!filePath) {
		return
	}
	fs.mkdirSync(path.dirname(filePath), { recursive: true })
	fs.appendFileSync(filePath, `${JSON.stringify(metric)}\n`, "utf8")
}

function formatDetailValue(value: string | number | boolean): string {
	if (typeof value === "string") {
		return JSON.stringify(value)
	}
	return String(value)
}

function logMetric(
	name: string,
	durationMs: number,
	details?: MetricDetails,
): void {
	if (!isDebugEnabled()) {
		return
	}

	const metric: RecordedMetric = {
		name,
		durationMs,
		details,
		timestamp: Date.now(),
	}
	recordedMetrics.push(metric)
	appendPerfMetricFile(metric)

	const detailStr = details
		? ` ${Object.entries(details)
				.map(([key, value]) => `${key}=${formatDetailValue(value)}`)
				.join(" ")}`
		: ""
	outputChannel?.appendLine(
		`[perf] ${name}: ${durationMs.toFixed(1)}ms${detailStr}`,
	)
}

export function createTimer(
	name: string,
	details?: MetricDetails,
): {
	end: (extraDetails?: MetricDetails) => number
} {
	const start = performance.now()
	return {
		end(extraDetails?: MetricDetails) {
			const durationMs = performance.now() - start
			logMetric(name, durationMs, { ...details, ...extraDetails })
			return durationMs
		},
	}
}
