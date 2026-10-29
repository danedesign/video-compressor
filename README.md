# SL Video Compressor

A local Windows desktop app for batch-compressing training videos. Video files are processed on the computer with FFmpeg; they are not uploaded.

## Run from source

Install Node.js 22.12 or newer, then from this directory:

```powershell
npm install
npm run setup
npm start
```

`npm run setup` downloads the Electron runtime for local development. The distributable build downloads and packages its own runtime.

## Build the portable Windows app

```powershell
npm run dist
```

The portable x64 executable is written to `dist/`. The build bundles FFmpeg and FFprobe, so the receiving computer does not need either installed.

## Compression behavior

- Encodes video as H.264/MP4 with FFmpeg `libx264`, medium preset and selectable CRF (24, 26, 28, 30, or 32; default 30). Higher CRF values favor smaller files and can visibly soften detail.
- Offers original, 720p, 1080p and 1440p QHD/2K output sizes. Aspect ratio is preserved; selected sizes may upscale as well as downscale.
- Preserves frame timing, copies audio streams, maps metadata/chapters, and enables MP4 fast-start.
- Checks selected output dimensions, frame rate (allowing small MP4 time-base rounding), duration and audio presence. A failed validation removes the candidate output.
- Writes copies to the selected output folder; it never overwrites or replaces an input. In original-resolution compression mode, a result that is not smaller is discarded. When a specific output size is selected, the result is kept even if upscaling makes it larger.

CRF is a quality/size trade-off, not a promise of visually lossless output. Review text-heavy recordings at the selected quality before distributing them. CRF 24 is a safer starting point for fine text; CRF 30 is the size-focused default; CRF 32 is an aggressive option that should be checked carefully.

Upscaling increases pixel dimensions but cannot restore detail absent from the source and may create a larger file.

Rotato's public compressor page says it uses FFmpeg/H.264 and reduces bitrate selectively, but does not publish its exact encoder arguments. This app uses a comparable size-focused H.264 approach, not Rotato's proprietary preset or a guaranteed match: https://tools.rotato.app/compress.

## Third-party notices

The portable build bundles FFmpeg and FFprobe binaries, both built with GPL-enabled components. Their GPL v3 license text and available build/source details are copied into `dist\win-unpacked\resources\licenses` (and bundled inside the portable executable). The `ffprobe-static` JavaScript package additionally includes its MIT notice; that notice does not replace the binary's GPL terms. Review the applicable GPL source-distribution requirements before redistributing the app.
