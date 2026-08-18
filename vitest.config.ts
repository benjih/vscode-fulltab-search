import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		exclude: [...configDefaults.exclude, "src/test/suite/**", "src/ui-test/**"],
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "lcovonly"],
			reportsDirectory: "coverage",
			// Both shipped halves of the extension: the host code in src/ and the
			// webview modules in media/ (exercised by webviewEditMode.test.ts).
			include: ["src/**/*.ts", "media/**/*.js"],
			exclude: [
				"src/test/**",
				"src/ui-test/**",
				"src/**/*.test.ts",
				// Type-only: JSDoc typedefs and interfaces, no runtime code.
				"src/search/types.ts",
				"media/types.js",
			],
			// Per-group gates rather than one global number. Only the webview
			// modules and the three src/search helpers below are reachable from
			// unit tests; extension.ts, searchPanel.ts, searchEngine.ts and
			// tokenizer.ts are exercised by the integration and UI tiers, which
			// run uninstrumented. A global threshold would therefore sit near 40%
			// and fail whenever an integration-only file was added, so files
			// outside these globs are reported but not gated.
			thresholds: {
				"media/**/*.js": {
					statements: 65,
					branches: 50,
					functions: 70,
					lines: 65,
				},
				"src/search/replacement.ts": {
					statements: 100,
					branches: 85,
					functions: 100,
					lines: 100,
				},
				"src/search/ripgrepParser.ts": {
					statements: 90,
					branches: 75,
					functions: 100,
					lines: 90,
				},
				"src/search/searchUtils.ts": {
					statements: 95,
					branches: 88,
					functions: 100,
					lines: 95,
				},
			},
		},
	},
})
