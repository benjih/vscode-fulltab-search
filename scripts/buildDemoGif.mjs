// Stitches the screenshots captured by demo.recording.ts into docs/demo.gif.
// Frame filenames look like `0042-1717920000000.png`; the timestamp suffix
// drives per-frame gif delays so the gif plays at recorded speed.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import gifenc from "gifenc"
import pngjs from "pngjs"

const { GIFEncoder, applyPalette, quantize } = gifenc
const { PNG } = pngjs

const TARGET_WIDTH = 960
const MIN_DELAY_MS = 20
const MAX_DELAY_MS = 2000
const FINAL_FRAME_HOLD_MS = 1500

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const framesDir = path.join(root, ".demo-frames")
const outFile = path.join(root, "docs", "demo.gif")

const frameFiles = fs
	.readdirSync(framesDir)
	.filter((name) => /^\d+-\d+\.png$/.test(name))
	.sort()

if (frameFiles.length === 0) {
	console.error(`No frames found in ${framesDir} — run the recording first.`)
	process.exit(1)
}

const timestamps = frameFiles.map((name) =>
	Number(name.split("-")[1].replace(".png", "")),
)

function scaleBilinear(src, srcWidth, srcHeight, dstWidth, dstHeight) {
	const dst = new Uint8ClampedArray(dstWidth * dstHeight * 4)
	const xRatio = (srcWidth - 1) / Math.max(dstWidth - 1, 1)
	const yRatio = (srcHeight - 1) / Math.max(dstHeight - 1, 1)
	for (let y = 0; y < dstHeight; y++) {
		const srcY = y * yRatio
		const y0 = Math.floor(srcY)
		const y1 = Math.min(y0 + 1, srcHeight - 1)
		const yFrac = srcY - y0
		for (let x = 0; x < dstWidth; x++) {
			const srcX = x * xRatio
			const x0 = Math.floor(srcX)
			const x1 = Math.min(x0 + 1, srcWidth - 1)
			const xFrac = srcX - x0
			const dstIndex = (y * dstWidth + x) * 4
			for (let channel = 0; channel < 4; channel++) {
				const topLeft = src[(y0 * srcWidth + x0) * 4 + channel]
				const topRight = src[(y0 * srcWidth + x1) * 4 + channel]
				const bottomLeft = src[(y1 * srcWidth + x0) * 4 + channel]
				const bottomRight = src[(y1 * srcWidth + x1) * 4 + channel]
				const top = topLeft + (topRight - topLeft) * xFrac
				const bottom = bottomLeft + (bottomRight - bottomLeft) * xFrac
				dst[dstIndex + channel] = top + (bottom - top) * yFrac
			}
		}
	}
	return dst
}

const gif = GIFEncoder()
let outputWidth = 0
let outputHeight = 0

for (let i = 0; i < frameFiles.length; i++) {
	const png = PNG.sync.read(
		fs.readFileSync(path.join(framesDir, frameFiles[i])),
	)
	if (outputWidth === 0) {
		outputWidth = Math.min(TARGET_WIDTH, png.width)
		outputHeight = Math.round((png.height / png.width) * outputWidth)
	}
	const rgba = scaleBilinear(
		png.data,
		png.width,
		png.height,
		outputWidth,
		outputHeight,
	)
	const palette = quantize(rgba, 256)
	const indexed = applyPalette(rgba, palette)
	const delay =
		i < frameFiles.length - 1
			? Math.min(
					Math.max(timestamps[i + 1] - timestamps[i], MIN_DELAY_MS),
					MAX_DELAY_MS,
				)
			: FINAL_FRAME_HOLD_MS
	gif.writeFrame(indexed, outputWidth, outputHeight, { palette, delay })
	if ((i + 1) % 20 === 0) {
		console.log(`Encoded ${i + 1}/${frameFiles.length} frames`)
	}
}

gif.finish()
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, gif.bytes())

const sizeMb = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1)
console.log(
	`Wrote ${outFile} (${frameFiles.length} frames, ${outputWidth}x${outputHeight}, ${sizeMb} MB)`,
)
