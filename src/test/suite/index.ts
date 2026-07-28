import * as path from "node:path"
import { pathToFileURL } from "node:url"
import type {
	File,
	Task,
	VitestRunner,
	VitestRunnerConfig,
} from "@vitest/runner"
import { glob } from "glob"
import { installVitestApi, type VitestRunnerModule } from "./vitestApi"

// Under `module: commonjs` tsc rewrites a literal `import()` into `require()`,
// which cannot load @vitest/runner's ESM build. Building the import through
// `new Function` keeps it a real dynamic import at runtime.
const importEsm = new Function("specifier", "return import(specifier)") as (
	specifier: string,
) => Promise<VitestRunnerModule>

const TIMEOUT_MS = 20_000

class ExtensionHostRunner implements VitestRunner {
	readonly config: VitestRunnerConfig = {
		root: path.resolve(__dirname, "../../.."),
		setupFiles: [],
		name: "integration",
		passWithNoTests: false,
		testNamePattern: undefined,
		allowOnly: true,
		sequence: { hooks: "stack", setupFiles: "list", seed: 0 },
		chaiConfig: undefined,
		maxConcurrency: 1,
		testTimeout: TIMEOUT_MS,
		hookTimeout: TIMEOUT_MS,
		retry: 0,
		includeTaskLocation: false,
		tags: [],
		tagsFilter: undefined,
		strictTags: false,
	}

	// The suites are already compiled to CommonJS in out/, so requiring them is
	// all the "import" they need — no transform pipeline is involved.
	importFile(filepath: string): unknown {
		return require(filepath)
	}
}

export async function run(): Promise<void> {
	const runner = await importEsm(
		pathToFileURL(require.resolve("@vitest/runner")).href,
	)
	installVitestApi(runner)

	const testsRoot = path.resolve(__dirname, "..")
	const files = await glob("suite/**/*.test.js", { cwd: testsRoot })
	const specs = files.sort().map((file) => path.resolve(testsRoot, file))

	const started = Date.now()
	const results = await runner.startTests(specs, new ExtensionHostRunner())
	report(results, Date.now() - started)

	const failures = collectFailures(results)
	if (failures.length > 0) {
		throw new Error(
			`${failures.length} test${failures.length === 1 ? "" : "s"} failed.`,
		)
	}
}

interface Failure {
	readonly name: string
	readonly errors: readonly { message?: string; stack?: string }[]
}

function collectFailures(tasks: readonly Task[]): Failure[] {
	const failures: Failure[] = []
	for (const task of tasks) {
		const errors = task.result?.errors ?? []
		// A failing test also marks its suite and file as failed, so only count
		// those when they carry an error of their own — a hook that threw, or a
		// file that could not be collected.
		const ownFailure =
			task.result?.state === "fail" &&
			(task.type === "test" || errors.length > 0)
		if (ownFailure) {
			failures.push({ name: task.fullName, errors })
		}
		if (task.type === "suite") {
			failures.push(...collectFailures(task.tasks))
		}
	}
	return failures
}

function report(files: readonly File[], durationMs: number): void {
	let passed = 0
	let skipped = 0

	const walk = (tasks: readonly Task[], depth: number): void => {
		const indent = "  ".repeat(depth)
		for (const task of tasks) {
			if (task.type === "suite") {
				console.log(`${indent}${task.name}`)
				walk(task.tasks, depth + 1)
				continue
			}
			const state = task.result?.state
			if (state === "fail") {
				console.log(`${indent}✖ ${task.name}`)
			} else if (state === "skip" || state === "todo") {
				skipped++
				console.log(`${indent}- ${task.name}`)
			} else {
				passed++
				console.log(
					`${indent}✔ ${task.name} (${Math.round(task.result?.duration ?? 0)}ms)`,
				)
			}
		}
	}

	console.log("")
	walk(files, 0)

	const failures = collectFailures(files)
	console.log("")
	console.log(`${passed} passing (${durationMs}ms)`)
	if (skipped > 0) {
		console.log(`${skipped} pending`)
	}
	if (failures.length === 0) {
		return
	}
	console.log(`${failures.length} failing`)
	failures.forEach((failure, index) => {
		console.log("")
		console.log(`${index + 1}) ${failure.name}`)
		for (const error of failure.errors) {
			console.log(error.stack ?? error.message ?? String(error))
		}
	})
}
