// Resets the scratch workspace and frame directory for a demo recording run.
// (Recording size is pinned by demo.recording.ts via CDP device emulation —
// extester wipes the settings dir at startup, so it cannot be seeded here.)
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const workspaceSource = path.join(root, "demo", "workspace")
const scratchWorkspace = path.join(root, ".demo-tmp")
const framesDir = path.join(root, ".demo-frames")

fs.rmSync(scratchWorkspace, { recursive: true, force: true })
fs.rmSync(framesDir, { recursive: true, force: true })
fs.cpSync(workspaceSource, scratchWorkspace, { recursive: true })
fs.mkdirSync(framesDir, { recursive: true })

console.log(`Demo workspace copied to ${scratchWorkspace}`)
