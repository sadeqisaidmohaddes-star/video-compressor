<#
.SYNOPSIS
    Smart video compressor. Drops duplicate / near-duplicate ("unnecessary")
    frames with FFmpeg's mpdecimate filter, then re-encodes efficiently.

.DESCRIPTION
    Two-stage shrink:
      1. mpdecimate  -> detects frames that barely differ from the previous one
                        (true duplicates + near-static frames) and removes them.
                        Variable-frame-rate output keeps original timestamps, so
                        total duration and audio sync are preserved.
      2. x265 / x264 CRF encode -> high-efficiency spatial compression on what's
                        left. CRF = constant quality, so quality stays stable while
                        bitrate (and file size) drops.

    Works on a single file or a whole folder (batch). Prints a before/after
    report including how many frames were deleted and the size saved.

.PARAMETER Input
    Path to a video file OR a folder. If a folder, every video inside is
    compressed (non-recursive unless -Recurse is set).

.PARAMETER Output
    Output file (single-file mode) or output folder (batch mode).
    Default: alongside the source as "<name>.compressed.mp4".

.PARAMETER Level
    Quality/size preset. Higher = smaller file.
      quality  -> CRF 22  (visually near-lossless, larger)
      high     -> CRF 26  (excellent quality, balanced)   [default]
      small    -> CRF 30  (noticeably smaller, good)
      tiny     -> CRF 34  (smallest, for previews/sharing)

.PARAMETER Crf
    Override the CRF value directly (0-51, lower = better quality / bigger).

.PARAMETER Codec
    h265 (libx265, best size)  [default]  or  h264 (libx264, max compatibility).

.PARAMETER Speed
    x264/x265 preset: ultrafast..placebo. Slower = smaller file, more CPU.
    Default: medium.

.PARAMETER Dedupe
    Frame-dropping strength:
      off        -> keep all frames (encode only)
      gentle     -> drop only near-exact duplicates
      normal     -> drop duplicates + redundant frames   [default]
      aggressive -> drop the most; best for screen recordings / slideshows

.PARAMETER AudioBitrate
    AAC audio bitrate, e.g. 128k. Use "copy" to keep original audio untouched.
    Default: 128k.

.PARAMETER Recurse
    In folder mode, also process sub-folders.

.PARAMETER WhatIf
    Show the FFmpeg command(s) that would run, without encoding.

.EXAMPLE
    .\Compress-Video.ps1 -Input "clip.mp4"

.EXAMPLE
    .\Compress-Video.ps1 -Input "C:\Videos" -Level small -Recurse

.EXAMPLE
    .\Compress-Video.ps1 -Input "screen.mkv" -Dedupe aggressive -Level tiny
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [Alias('Input', 'In', 'i')]
    [string]$Source,

    [Parameter(Position = 1)]
    [Alias('Out', 'o')]
    [string]$Output,

    [ValidateSet('quality', 'high', 'small', 'tiny')]
    [string]$Level = 'high',

    [ValidateRange(0, 51)]
    [int]$Crf = -1,

    [ValidateSet('h265', 'h264')]
    [string]$Codec = 'h265',

    [ValidateSet('ultrafast', 'superfast', 'veryfast', 'faster', 'fast',
        'medium', 'slow', 'slower', 'veryslow')]
    [string]$Speed = 'medium',

    [ValidateSet('off', 'gentle', 'normal', 'aggressive')]
    [string]$Dedupe = 'normal',

    [string]$AudioBitrate = '128k',

    [switch]$Recurse
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Pre-flight: make sure FFmpeg is on PATH
# ---------------------------------------------------------------------------
foreach ($exe in 'ffmpeg', 'ffprobe') {
    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) {
        Write-Host "ERROR: '$exe' was not found on PATH." -ForegroundColor Red
        Write-Host "Install it with:  winget install Gyan.FFmpeg" -ForegroundColor Yellow
        exit 1
    }
}

$VideoExtensions = '.mp4', '.mov', '.mkv', '.avi', '.wmv', '.flv', '.webm',
                   '.m4v', '.mpg', '.mpeg', '.ts', '.m2ts', '.3gp', '.vob'

# CRF per quality level (x265 scale; x264 gets a small offset so quality matches)
$LevelCrf = @{ quality = 22; high = 26; small = 30; tiny = 34 }

# mpdecimate parameter sets, gentle -> aggressive
$DedupeFilters = @{
    gentle     = 'mpdecimate=hi=512:lo=320:frac=0.33'   # 64*8 : 64*5
    normal     = 'mpdecimate=hi=768:lo=320:frac=0.33'   # 64*12: 64*5  (defaults)
    aggressive = 'mpdecimate=hi=1280:lo=512:frac=0.2'   # 64*20: 64*8
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Format-Size([double]$Bytes) {
    if ($Bytes -ge 1GB) { return ('{0:N2} GB' -f ($Bytes / 1GB)) }
    if ($Bytes -ge 1MB) { return ('{0:N2} MB' -f ($Bytes / 1MB)) }
    if ($Bytes -ge 1KB) { return ('{0:N2} KB' -f ($Bytes / 1KB)) }
    return "$Bytes B"
}

function Get-FrameCount([string]$Path) {
    # Fast path: frame count stored in container metadata.
    $n = & ffprobe -v error -select_streams v:0 -show_entries stream=nb_frames `
        -of csv=p=0 "$Path" 2>$null
    if ($n -and "$n".Trim() -match '^\d+$' -and [int]"$n".Trim() -gt 0) { return [int]"$n".Trim() }
    # Accurate fallback: decode and count (used for VFR / missing metadata).
    $n = & ffprobe -v error -select_streams v:0 -count_frames `
        -show_entries stream=nb_read_frames -of csv=p=0 "$Path" 2>$null
    if ($n -and "$n".Trim() -match '^\d+$') { return [int]"$n".Trim() }
    return 0
}

function Compress-One {
    param([string]$Src, [string]$Dst)

    $srcItem = Get-Item -LiteralPath $Src
    $srcSize = $srcItem.Length
    $srcFrames = Get-FrameCount $Src

    Write-Host ""
    Write-Host ("> " + $srcItem.Name) -ForegroundColor Cyan
    Write-Host ("  source : {0}" -f (Format-Size $srcSize)) -ForegroundColor DarkGray

    # ---- assemble the video filter chain -------------------------------
    $filters = @()
    if ($Dedupe -ne 'off') { $filters += $DedupeFilters[$Dedupe] }
    # 10-bit -> 8-bit safety + broad player compatibility
    $filters += 'format=yuv420p'
    $vf = ($filters -join ',')

    # ---- encoder settings ----------------------------------------------
    $effectiveCrf = if ($Crf -ge 0) { $Crf } else { $LevelCrf[$Level] }
    if ($Codec -eq 'h264') {
        $vcodec = 'libx264'
        $effectiveCrf = [Math]::Max(0, $effectiveCrf - 5)  # x264 CRF runs lower
    } else {
        $vcodec = 'libx265'
    }

    # ---- audio ----------------------------------------------------------
    $audioArgs = if ($AudioBitrate -eq 'copy') { @('-c:a', 'copy') }
                 else { @('-c:a', 'aac', '-b:a', $AudioBitrate) }

    $ffArgs = @(
        '-y', '-hide_banner', '-stats', '-loglevel', 'error',
        '-i', $Src,
        '-vf', $vf,
        '-fps_mode', 'vfr',          # honour the dropped frames
        '-c:v', $vcodec,
        '-crf', "$effectiveCrf",
        '-preset', $Speed,
        '-pix_fmt', 'yuv420p'
    ) + $audioArgs + @(
        '-movflags', '+faststart',   # web-streamable mp4
        $Dst
    )

    if ($PSCmdlet.ShouldProcess($Src, "FFmpeg -> $Dst")) {
        Write-Host ("  filter : {0}" -f $vf) -ForegroundColor DarkGray
        Write-Host ("  encode : {0} CRF {1} ({2})" -f $vcodec, $effectiveCrf, $Speed) -ForegroundColor DarkGray

        # The call operator quotes each argument correctly, including paths
        # that contain spaces. FFmpeg prints its progress live.
        & ffmpeg @ffArgs
        $code = $LASTEXITCODE

        if ($code -ne 0 -or -not (Test-Path -LiteralPath $Dst)) {
            Write-Host ("  FAILED (ffmpeg exit code {0})" -f $code) -ForegroundColor Red
            return $null
        }

        $outFrames = Get-FrameCount $Dst
        $dstSize = (Get-Item -LiteralPath $Dst).Length
        $saved = $srcSize - $dstSize
        $pct = if ($srcSize -gt 0) { 100 * $saved / $srcSize } else { 0 }

        Write-Host ("  output : {0}" -f (Format-Size $dstSize)) -ForegroundColor Green
        if ($Dedupe -ne 'off' -and $srcFrames -gt 0 -and $outFrames -gt 0) {
            $dropped = $srcFrames - $outFrames
            if ($dropped -lt 0) { $dropped = 0 }
            $fpct = if ($srcFrames -gt 0) { 100 * $dropped / $srcFrames } else { 0 }
            Write-Host ("  frames : {0:N0} -> {1:N0}  ({2:N0} dropped, {3:N1}%)" -f `
                $srcFrames, $outFrames, $dropped, $fpct) -ForegroundColor Green
        } elseif ($Dedupe -ne 'off' -and $outFrames -gt 0) {
            Write-Host ("  frames : kept {0:N0} after dedupe" -f $outFrames) -ForegroundColor Green
        }
        $color = if ($pct -ge 0) { 'Green' } else { 'Yellow' }
        Write-Host ("  saved  : {0}  ({1:N1}%)" -f (Format-Size ([Math]::Abs($saved))), $pct) -ForegroundColor $color

        return [pscustomobject]@{
            File       = $srcItem.Name
            BeforeByte = $srcSize
            AfterByte  = $dstSize
            Percent    = $pct
            Dropped    = if ($srcFrames -gt 0) { $srcFrames - $outFrames } else { $null }
        }
    }
    return $null
}

# ---------------------------------------------------------------------------
# Resolve inputs
# ---------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $Source)) {
    Write-Host "ERROR: input not found: $Source" -ForegroundColor Red
    exit 1
}

$inItem = Get-Item -LiteralPath $Source
$jobs = @()   # array of @{ Src; Dst }

if ($inItem.PSIsContainer) {
    # ---- batch (folder) mode ----
    $gciParams = @{ LiteralPath = $inItem.FullName; File = $true }
    if ($Recurse) { $gciParams.Recurse = $true }
    $vids = Get-ChildItem @gciParams |
        Where-Object { $VideoExtensions -contains $_.Extension.ToLower() -and `
                       $_.Name -notlike '*.compressed.*' }

    if (-not $vids) { Write-Host "No videos found in $($inItem.FullName)" -ForegroundColor Yellow; exit 0 }

    $outDir = if ($Output) { $Output } else { $inItem.FullName }
    if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

    foreach ($v in $vids) {
        $dst = Join-Path $outDir ($v.BaseName + '.compressed.mp4')
        $jobs += @{ Src = $v.FullName; Dst = $dst }
    }
    Write-Host ("Batch: {0} video(s) in {1}" -f $jobs.Count, $inItem.FullName) -ForegroundColor White
}
else {
    # ---- single-file mode ----
    if ($Output) {
        # If Output is an existing folder, drop the file inside it.
        if ((Test-Path -LiteralPath $Output -PathType Container)) {
            $dst = Join-Path $Output ($inItem.BaseName + '.compressed.mp4')
        } else { $dst = $Output }
    } else {
        $dst = Join-Path $inItem.DirectoryName ($inItem.BaseName + '.compressed.mp4')
    }
    $jobs += @{ Src = $inItem.FullName; Dst = $dst }
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
$results = @()
foreach ($job in $jobs) {
    if ($job.Src -eq $job.Dst) {
        Write-Host "Skipping (output would overwrite input): $($job.Src)" -ForegroundColor Yellow
        continue
    }
    $r = Compress-One -Src $job.Src -Dst $job.Dst
    if ($r) { $results += $r }
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
if ($results.Count -gt 1) {
    $tb = ($results | Measure-Object BeforeByte -Sum).Sum
    $ta = ($results | Measure-Object AfterByte  -Sum).Sum
    $tp = if ($tb -gt 0) { 100 * ($tb - $ta) / $tb } else { 0 }
    Write-Host ""
    Write-Host ("=== {0} files | {1} -> {2} | saved {3:N1}% ===" -f `
        $results.Count, (Format-Size $tb), (Format-Size $ta), $tp) -ForegroundColor Cyan
}
elseif ($results.Count -eq 1) {
    Write-Host ""
    Write-Host "Done." -ForegroundColor Cyan
}
