# CLAUDE.md — Smart Video Compressor

A local-first video compressor that **deletes duplicate / near-static frames**
(FFmpeg `mpdecimate`) and re-encodes to shrink files. Ships in three forms off
one shared idea: a CLI, a fast local web app (native FFmpeg), and an offline
in-browser web app (FFmpeg WebAssembly).

> This folder is a **separate project** living inside the `Mohaddis Projects`
> parent (whose root is the unrelated `semantica` CSS library). Keep this
> project's files under `video-compressor/` — don't leak them into the root.

## Goals

1. **Shrink video by removing redundant frames first** — `mpdecimate` drops
   frames that barely differ from the previous one; then a CRF encode does the
   spatial compression. Best wins on screen recordings, slideshows, gameplay,
   talking-head.
2. **Preserve correctness** — variable-frame-rate output keeps original
   timestamps, so duration and audio stay in sync after frames are dropped.
3. **Fast by default** — the web app runs the machine's *native* FFmpeg (GPU
   when available, else multi-core CPU H.264), not slow in-browser WASM.
4. **Local & private** — nothing is uploaded; everything runs on `localhost`.
5. **Zero install to run** — needs only FFmpeg on PATH (`winget install Gyan.FFmpeg`)
   and Node (for the web server). No npm dependencies.

## Structure

```
video-compressor/
  Compress-Video.ps1              # CLI compressor (PowerShell + native ffmpeg)
  Compress (drop videos here).bat # drag-and-drop wrapper for the CLI
  Launch fast compressor.bat      # starts the native web app (server/) on :5060
  Launch website.bat              # starts the offline WASM web app (web/) on :5050
  README.md                       # user-facing usage docs
  CLAUDE.md                       # this file

  server/                         # FAST web app — native FFmpeg backend
    server.mjs                    # zero-dep Node HTTP server + ffmpeg orchestration
    public/index.html             # frontend (upload, options, live SSE progress)

  web/                            # OFFLINE web app — FFmpeg compiled to WASM (slow)
    index.html                    # self-contained frontend (ffmpeg.wasm)
    serve.json                    # COOP/COEP headers (SharedArrayBuffer needs them)
    vendor/                       # bundled engine: ffmpeg.min.js + ffmpeg-core.* (~25 MB)
```

## Sections (the three apps)

### 1. CLI — `Compress-Video.ps1`
Native ffmpeg wrapper. Single file or whole folder (`-Recurse`). Prints
before/after size and frames dropped.
- Options: `-Level quality|high|small|tiny` (CRF), `-Dedupe off|gentle|normal|aggressive`,
  `-Codec h265|h264`, `-Speed <x264/5 preset>`, `-AudioBitrate <k|copy>`, `-WhatIf`.
- Invokes ffmpeg via the call operator (`& ffmpeg @args`) so paths with spaces
  quote correctly; frame counts come from `ffprobe`.

### 2. Native web app — `server/`  (the fast one, default)
`Launch fast compressor.bat` → `node server/server.mjs` → opens `http://127.0.0.1:5060`.
- **Server** (`server.mjs`, pure Node, no deps): static frontend + JSON API.
  - `GET /capabilities` — probes which encoders actually work on this hardware
    (1-frame test encode) and returns the available **speed profiles**.
  - `POST /jobs?name=&level=&dedupe=&encoder=` — raw file body → temp file + ffprobe.
  - `GET /jobs/:id/events` — SSE: starts ffmpeg, streams `progress` (parsed from
    `-progress pipe:1`), then `done` (sizes, frames, encoder) or `error`.
  - `GET /jobs/:id/file` — streams the result; temp files cleaned up after.
  - Binds dual-stack (`::`) so `localhost` and `127.0.0.1` both reach it.
- **Speed profiles** (auto-filtered by hardware, fastest first):
  `🚀 gpu` (NVENC/QSV/AMF) · `⚡ h264fast` (x264 veryfast, default) ·
  `⚖ h264bal` (x264 fast) · `🗜 h265small` (x265 medium, smallest).
- **Frontend** (`public/index.html`): drag/drop, Quality + Frame-cleanup +
  Speed selects, live progress bar with %/speed/ETA, inline preview + download.

### 3. Offline web app — `web/`  (no server, fully in-browser)
`Launch website.bat` → static server on :5050. Uses `ffmpeg.wasm` (single-thread
WASM) bundled locally in `vendor/`. Works with no Node backend, but is much
slower. `serve.json` sets COOP/COEP so `SharedArrayBuffer` is available;
`corePath` must be an **absolute** URL (ffmpeg.wasm 0.11 resolves relative paths
against an internal `file://` base).

## Core encode pipeline (shared by all three)

```
ffmpeg -i in -vf "<mpdecimate>,format=yuv420p" -fps_mode vfr \
       <encoder+crf> -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart out.mp4
```
`mpdecimate` strengths: gentle `hi=512:lo=320:frac=0.33`, normal
`hi=768:lo=320:frac=0.33`, aggressive `hi=1280:lo=512:frac=0.2`.

## Run / dev

```bash
# Fast (native) web app — recommended
double-click "Launch fast compressor.bat"      # or: node server/server.mjs

# CLI
./Compress-Video.ps1 -Source clip.mp4 -Level small -Dedupe aggressive

# Offline (WASM) web app
double-click "Launch website.bat"
```
Background-started servers don't survive a tool session; use the `.bat` so the
server stays alive in its own window.

## Hardware note (this machine)

GPU encoding (NVENC) is currently **off**: the GTX 1070 needs NVIDIA driver
**≥ 570** for FFmpeg 8.1's NVENC API; the installed driver is older, so the
server falls back to CPU H.264/H.265. Updating the driver makes `/capabilities`
auto-offer the `🚀 GPU` profile on next launch. No Intel QSV / AMD AMF present.

## Roadmap

- [ ] **Fix browser launch reliability** — the `.bat` is the supported path;
      consider bundling Node or a tray launcher so the server persists cleanly.
- [ ] **Server frame-drop count in UI** — surface `srcFrames → outFrames` more
      prominently (data already sent in the `done` event).
- [ ] **GPU path validation** once a ≥570 driver is installed (NVENC `-cq` tuning).
- [ ] **AV1 option** (`av1_nvenc`/`libsvtav1`) for smaller files where supported.
- [ ] **Trim / time-range** input before compressing.
- [ ] **Range requests** on `/jobs/:id/file` so large outputs stream/seek in the
      `<video>` preview without a full blob fetch.
- [ ] **Batch upload** in the web app (CLI already does folders).
- [ ] **Resume/large-file safety** — chunked upload + disk-space guard.

## Conventions

- No npm dependencies anywhere; only FFmpeg + Node stdlib.
- Encoder/profile choices live server-side in `ENCODERS`/`buildProfiles`
  (`server.mjs`); the frontend just renders `/capabilities`.
- Logical/relative paths quoted for spaces; never hardcode the temp dir.
- Keep the three apps' UI/options in sync conceptually (same Level / Dedupe vocab).
```
