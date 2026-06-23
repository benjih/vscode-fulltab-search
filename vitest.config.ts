import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		exclude: [
			...configDefaults.exclude,
			"src/test/suite/**",
			"src/ui-test/**",
			"src/search/ripgrepParser.test.ts",
			"src/search/searchUtils.test.ts",
		],
	},
})
