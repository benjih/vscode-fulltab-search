import * as fs from "node:fs"
import * as path from "node:path"
import type { RecordedMetric } from "../debug/metrics"

const FIXTURE_WORKSPACE = path.resolve(
	__dirname,
	"../../src/test/fixtures/sample-workspace",
)

export function perfMetricsFilePath(): string {
	const configured = process.env.FULLTAB_PERF_FILE?.trim()
	if (configured) {
		const projectRoot = path.resolve(__dirname, "../..")
		return path.isAbsolute(configured)
			? configured
			: path.resolve(projectRoot, configured)
	}
	return path.join(FIXTURE_WORKSPACE, ".fulltab-perf.ndjson")
}

export function clearPerfMetricsFile(): void {
	const filePath = perfMetricsFilePath()
	fs.mkdirSync(path.dirname(filePath), { recursive: true })
	fs.writeFileSync(filePath, "", "utf8")
}

export function readPerfMetricsFile(): RecordedMetric[] {
	const filePath = perfMetricsFilePath()
	if (!fs.existsSync(filePath)) {
		return []
	}

	return fs
		.readFileSync(filePath, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as RecordedMetric)
}

export async function waitForPerfMetric(
	name: string,
	timeoutMs = 20_000,
): Promise<RecordedMetric> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const metrics = readPerfMetricsFile()
		for (let i = metrics.length - 1; i >= 0; i--) {
			if (metrics[i].name === name) {
				return metrics[i]
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 200))
	}

	const metrics = readPerfMetricsFile()
	throw new Error(
		`Timed out waiting for perf metric "${name}". Recorded: ${metrics.map((metric) => metric.name).join(", ") || "(none)"}`,
	)
}
