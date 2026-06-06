import * as vscode from "vscode"

const CONFIG_SECTION = "fullTabSearch"
const OUTPUT_CHANNEL_NAME = "FullTab Search"

let outputChannel: vscode.OutputChannel | undefined

export function initDebugOutput(context: vscode.ExtensionContext): void {
	outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME)
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
