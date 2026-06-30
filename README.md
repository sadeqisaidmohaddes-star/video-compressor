# Smart Video Compressor

**[Open the browser compressor](https://sadeqisaidmohaddes-star.github.io/video-compressor/)**

> **Project history:** The original concept and working project date to 2022.
> This repository was reconstructed and republished in 2026 after the original
> GitHub repository was lost.

A small, powerful video compressor for Windows built on **FFmpeg**. It does two
things to shrink a video as much as possible while keeping it looking good:

1. **Deletes duplicate / unnecessary frames** — the `mpdecimate` filter scans the
   video and drops frames that barely differ from the one before them (exact
   duplicates and near-static frames). Timestamps are preserved, so the duration
   and audio sync stay correct.
2. **Re-encodes efficiently** — modern **H.265 (x265)** with constant-quality
   (CRF) encoding gives a big size reduction at a quality you choose.

This is especially effective on screen recordings, slideshows, gameplay,
talking-head videos, and anything with static or repeated frames.

---

## Requirements

- **FFmpeg** on your PATH. Install it once:
  ```powershell
  winget install Gyan.FFmpeg
  ```
  (Already installed on this machine.)

---

## Easiest way — drag & drop

Drag one or more video files (or a folder) onto **`Compress (drop videos here).bat`**.
Each result is saved next to the original as `name.compressed.mp4`.

---

## PowerShell usage

```powershell
# Simplest — compress one file with great default quality
.\Compress-Video.ps1 -Source "clip.mp4"

# Smaller file
.\Compress-Video.ps1 -Source "clip.mp4" -Level small

# Screen recording / slideshow — drop as many redundant frames as possible
.\Compress-Video.ps1 -Source "screen.mkv" -Dedupe aggressive -Level tiny

# Compress every video in a folder (and sub-folders)
.\Compress-Video.ps1 -Source "C:\Videos" -Recurse

# Maximum compatibility (H.264 instead of H.265)
.\Compress-Video.ps1 -Source "clip.mp4" -Codec h264

# Preview the FFmpeg command without encoding
.\Compress-Video.ps1 -Source "clip.mp4" -WhatIf
```

> If PowerShell blocks the script, run it once as:
> `powershell -ExecutionPolicy Bypass -File .\Compress-Video.ps1 -Source "clip.mp4"`

---

## Options

| Option           | Values                                              | Default  | What it does |
|------------------|-----------------------------------------------------|----------|--------------|
| `-Source`        | file or folder                                      | —        | Input. Alias: `-Input`, `-i`. |
| `-Output`        | file or folder                                      | next to source | Where to write. |
| `-Level`         | `quality` `high` `small` `tiny`                     | `high`   | Quality/size preset (CRF 22/26/30/34). |
| `-Crf`           | `0`–`51`                                             | —        | Override CRF directly (lower = better/bigger). |
| `-Codec`         | `h265` `h264`                                        | `h265`   | Encoder. h265 = smaller, h264 = most compatible. |
| `-Speed`         | `ultrafast` … `veryslow`                             | `medium` | Slower = smaller file, more CPU time. |
| `-Dedupe`        | `off` `gentle` `normal` `aggressive`                 | `normal` | How hard to drop duplicate/redundant frames. |
| `-AudioBitrate`  | e.g. `128k`, or `copy`                               | `128k`   | Re-encode audio to AAC, or `copy` to keep as-is. |
| `-Recurse`       | switch                                               | off      | In folder mode, include sub-folders. |
| `-WhatIf`        | switch                                               | off      | Show the command without running it. |

### Quality levels at a glance

| Level     | CRF | Use it for |
|-----------|-----|------------|
| `quality` | 22  | Archival / near-lossless, largest file |
| `high`    | 26  | **Default** — excellent quality, balanced size |
| `small`   | 30  | Sharing — noticeably smaller, still good |
| `tiny`    | 34  | Previews / quick sends, smallest file |

### Dedupe strength

| Mode         | Drops |
|--------------|-------|
| `off`        | Nothing (re-encode only) |
| `gentle`     | Only near-exact duplicate frames |
| `normal`     | Duplicates + redundant frames (**default**) |
| `aggressive` | The most — best for screen recordings & slideshows |

---

## What the report shows

After each file you'll see the source size, output size, **how many frames were
deleted**, and the percentage saved — for example:

```
> screen.mkv
  source : 84.10 MB
  output : 9.32 MB
  frames : 3,600 -> 410  (3,190 dropped, 88.6%)
  saved  : 74.78 MB  (88.9%)
```

---

## Notes & tips

- Output is always `.mp4` with `+faststart` (ready to stream / upload).
- H.265 has the best size but is slightly slower to encode and slightly less
  universally supported than H.264. Use `-Codec h264` if a target device
  can't play the result.
- `mpdecimate` produces a **variable frame rate**. That's intentional and
  correct — it's what keeps duration and audio in sync after dropping frames.
- If a file *grows* after compression, the source was already smaller/efficient
  than the chosen settings — raise the CRF (`-Level small`/`tiny`) or use
  `-Dedupe aggressive`.
