// Intercepts require('vscode') so mocha unit tests can load extension code
// without a VS Code host. Import this before any module that imports vscode.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const NativeModule = require("node:module")

export const vscodeMock = {
	workspace: {
		workspaceFolders: undefined as { uri: { fsPath: string } }[] | undefined,
		asRelativePath: (p: string) => p,
	},
}

const STUB_KEY = "__vscode_unit_stub__"

// Redirect require('vscode') → our fake key before Node tries to find it on disk
const _original = NativeModule._resolveFilename
NativeModule._resolveFilename = function (
	request: string,
	...rest: unknown[]
) {
	if (request === "vscode") return STUB_KEY
	return _original.call(NativeModule, request, ...rest)
}

// Pre-populate the cache so the redirected key resolves immediately
;(require as NodeJS.Require & { cache: Record<string, unknown> })[
	"cache"
][STUB_KEY] = {
	id: STUB_KEY,
	filename: STUB_KEY,
	loaded: true,
	exports: vscodeMock,
	paths: [],
	children: [],
}
