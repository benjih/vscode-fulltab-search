import * as path from "node:path"
import { glob } from "glob"
import Mocha from "mocha"

export function run(): Promise<void> {
	const mocha = new Mocha({
		ui: "tdd",
		color: true,
	})

	const testsRoot = path.resolve(__dirname, "..")

	return new Promise((resolve, reject) => {
		glob("suite/**/*.test.js", { cwd: testsRoot }).then((files) => {
			for (const file of files) {
				mocha.addFile(path.resolve(testsRoot, file))
			}

			try {
				mocha.run((failures: number) => {
					if (failures > 0) {
						reject(new Error(`${failures} tests failed.`))
					} else {
						resolve()
					}
				})
			} catch (err) {
				reject(err)
			}
		})
	})
}
