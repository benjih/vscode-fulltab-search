import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main() {
	try {
		const extensionDevelopmentPath = path.resolve(__dirname, "../../");
		const extensionTestsPath = path.resolve(__dirname, "./suite/index");
		const workspacePath = path.join(
			extensionDevelopmentPath,
			"src/test/fixtures/sample-workspace",
		);

		await runTests({
			extensionDevelopmentPath,
			extensionTestsPath,
			launchArgs: [workspacePath, "--disable-extensions"],
		});
	} catch (err) {
		console.error("Failed to run tests", err);
		process.exit(1);
	}
}

main();
