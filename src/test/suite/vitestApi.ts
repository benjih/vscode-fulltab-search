import type { SuiteAPI, TestAPI } from "@vitest/runner"

export type VitestRunnerModule = typeof import("@vitest/runner")

// @vitest/runner ships ESM only, but these suites are compiled to CommonJS so
// the extension host can require them. The suites therefore import the test API
// from here, and `index.ts` fills these bindings in once its dynamic import of
// the runner resolves — before any suite file is loaded. TypeScript compiles an
// exported `let` to a property on `exports`, and every call site to a property
// read, so the assignment below is visible to modules that already imported it.
export let describe: SuiteAPI = notLoaded("describe")
export let it: TestAPI = notLoaded("it")
export let beforeAll: VitestRunnerModule["beforeAll"] = notLoaded("beforeAll")
export let afterAll: VitestRunnerModule["afterAll"] = notLoaded("afterAll")

export function installVitestApi(runner: VitestRunnerModule): void {
	describe = runner.describe
	it = runner.it
	beforeAll = runner.beforeAll
	afterAll = runner.afterAll
}

function notLoaded<T>(name: string): T {
	return ((): never => {
		throw new Error(`${name}() was called before the vitest runner loaded`)
	}) as unknown as T
}
