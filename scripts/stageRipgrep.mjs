// Stage the ripgrep binary matching a cross-compiled package target.
//
// @vscode/ripgrep 1.18 ships one prebuilt binary per platform as an
// optionalDependency and npm installs whichever matches the *build host*. The
// release matrix packages targets the host does not match — linux-arm64 and
// win32-arm64 on x64 runners, darwin-x64 on an arm64 mac — so three of the six
// vsix files would otherwise carry a binary that cannot execute, and search
// would fail outright on those platforms.
//
// Re-running npm with --os/--cpu is not usable here: it filters *all* optional
// deps, so it also swaps TypeScript 7's native compiler binary to the target
// platform and `tsc` can no longer run. Fetching with `npm install --force`
// is no better, because reifying the tree prunes the extraneous wasm packages
// knip's toolchain leaves at the top of node_modules, which breaks the
// `npm ls --omit=dev` that vsce runs to build its file list.
//
// So unpack the tarball directly and leave the dependency tree untouched.

import { execFileSync } from "node:child_process"
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs"
// Forward slashes throughout: Node's fs accepts them on Windows, and the tar
// invocation below needs them (MSYS tar does not treat "\" as a separator).
import { posix } from "node:path"

const { join } = posix

const VSCODE_DIR = join("node_modules", "@vscode")

const target = process.argv[2]
if (!target) {
	console.error(
		"usage: node scripts/stageRipgrep.mjs <target>  (e.g. linux-arm64)",
	)
	process.exit(1)
}

// The installed @vscode/ripgrep is the authority on both the valid target names
// and the exact version to fetch, so the two can never drift out of sync.
const { optionalDependencies } = JSON.parse(
	readFileSync(join(VSCODE_DIR, "ripgrep", "package.json"), "utf8"),
)
const pkgName = `@vscode/ripgrep-${target}`
const version = optionalDependencies?.[pkgName]
if (!version) {
	const known = Object.keys(optionalDependencies ?? {})
		.map((n) => n.replace("@vscode/ripgrep-", ""))
		.join(", ")
	console.error(
		`unknown target "${target}"; @vscode/ripgrep supports: ${known}`,
	)
	process.exit(1)
}

const dest = join(VSCODE_DIR, pkgName.replace("@vscode/", ""))
// Stage inside node_modules rather than the OS temp dir, and keep every path
// handed to tar relative. GNU tar — which is what `shell: bash` puts on PATH on
// the Windows runners — reads a colon in the -f argument as a remote host spec,
// so an absolute Windows path fails with "Cannot connect to C: resolve failed".
// A relative path has no colon and suits both GNU tar and bsdtar.
const stage = mkdtempSync(join("node_modules", ".stage-rg-"))
try {
	execFileSync(
		"npm",
		["pack", `${pkgName}@${version}`, "--pack-destination", stage],
		{
			stdio: ["ignore", "ignore", "inherit"],
			shell: process.platform === "win32",
		},
	)
	const tarball = readdirSync(stage).find((f) => f.endsWith(".tgz"))
	if (!tarball)
		throw new Error(`npm pack produced no tarball for ${pkgName}@${version}`)

	rmSync(dest, { recursive: true, force: true })
	mkdirSync(dest, { recursive: true })
	execFileSync(
		"tar",
		["-xzf", join(stage, tarball), "-C", dest, "--strip-components=1"],
		{
			stdio: "inherit",
		},
	)
} finally {
	rmSync(stage, { recursive: true, force: true })
}

// Drop every other platform's binary so the vsix carries exactly one.
for (const entry of readdirSync(VSCODE_DIR)) {
	if (entry.startsWith("ripgrep-") && entry !== `ripgrep-${target}`) {
		rmSync(join(VSCODE_DIR, entry), { recursive: true, force: true })
	}
}

const staged = readdirSync(join(dest, "bin"))
if (staged.length === 0) throw new Error(`${pkgName} staged without a binary`)
console.log(`staged ${pkgName}@${version} (bin/${staged.join(", bin/")})`)
