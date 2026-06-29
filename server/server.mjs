// Smart Video Compressor — local native-FFmpeg backend.
// Runs the machine's installed ffmpeg (GPU-accelerated when available),
// so it is far faster than the in-browser WebAssembly build.
//
// Pure Node (no dependencies). Binds to 127.0.0.1 only — local use.
//
//   node server.mjs            # port 5060
//   PORT=5070 node server.mjs

import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, createReadStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const TMP = path.join(os.tmpdir(), 'svc-jobs');
const PORT = Number(process.env.PORT) || 5060;

await fs.mkdir(TMP, { recursive: true });

// ---------------------------------------------------------------------------
// Quality / encoder configuration
// ---------------------------------------------------------------------------
const LEVELS = ['quality', 'high', 'small', 'tiny'];

const DEDUPE = {
  off:        null,
  gentle:     'mpdecimate=hi=512:lo=320:frac=0.33',
  normal:     'mpdecimate=hi=768:lo=320:frac=0.33',
  aggressive: 'mpdecimate=hi=1280:lo=512:frac=0.2',
};

// Quality numbers per level, per encoder family (lower = better/bigger).
const Q = {
  x264: { quality: 18, high: 22, small: 26, tiny: 30 },
  x265: { quality: 22, high: 26, small: 30, tiny: 34 },
  nv:   { quality: 19, high: 24, small: 29, tiny: 33 },
  qsv:  { quality: 20, high: 25, small: 30, tiny: 34 },
  amf:  { quality: 20, high: 25, small: 30, tiny: 34 },
};

// Raw encoders we probe for hardware support.
const RAW_ENCODERS = ['hevc_nvenc', 'h264_nvenc', 'hevc_qsv', 'h264_qsv',
                      'hevc_amf', 'h264_amf', 'libx265', 'libx264'];

// GPU encoder argument builder (tuned for SPEED).
function gpuArgs(enc, level) {
  if (enc.endsWith('nvenc')) return ['-c:v', enc, '-preset', 'p4', '-rc', 'vbr', '-cq', String(Q.nv[level]), '-tune', 'hq'];
  if (enc.endsWith('qsv'))   return ['-c:v', enc, '-preset', 'veryfast', '-global_quality', String(Q.qsv[level])];
  return ['-c:v', enc, '-rc', 'cqp', '-qp_i', String(Q.amf[level]), '-qp_p', String(Q.amf[level]), '-quality', 'speed'];
}

function pickGpu(available) {
  // prefer HEVC, then H.264; vendor order NVIDIA, Intel, AMD
  return ['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'h264_nvenc', 'h264_qsv', 'h264_amf']
    .find(e => available[e]) || null;
}

// Build the user-facing SPEED profiles from whatever encoders actually work.
function buildProfiles(available) {
  const profiles = [];
  const gpu = pickGpu(available);
  if (gpu) {
    const vendor = gpu.includes('nvenc') ? 'NVIDIA' : gpu.includes('qsv') ? 'Intel' : 'AMD';
    const codec = gpu.startsWith('hevc') ? 'H.265' : 'H.264';
    profiles.push({ id: 'gpu', label: `🚀 Fastest — GPU (${vendor} ${codec})`, codec: gpu, build: l => gpuArgs(gpu, l) });
  }
  if (available.libx264) {
    profiles.push({ id: 'h264fast', label: '⚡ Fastest — H.264 (CPU)', codec: 'libx264',
      build: l => ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(Q.x264[l])] });
    profiles.push({ id: 'h264bal', label: '⚖ Balanced — H.264 (CPU)', codec: 'libx264',
      build: l => ['-c:v', 'libx264', '-preset', 'fast', '-crf', String(Q.x264[l])] });
  }
  if (available.libx265) {
    profiles.push({ id: 'h265small', label: '🗜 Smallest — H.265 (CPU, slower)', codec: 'libx265',
      build: l => ['-c:v', 'libx265', '-preset', 'medium', '-crf', String(Q.x265[l])] });
  }
  return profiles;
}

// ---------------------------------------------------------------------------
// Probe which encoders actually work on THIS hardware (build support != GPU
// present). Each gets a 1-frame test encode.
// ---------------------------------------------------------------------------
function probeEncoder(enc) {
  return new Promise(resolve => {
    let p;
    try {
      p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'nullsrc=s=320x240:d=0.1', '-frames:v', '1',
        '-c:v', enc, '-f', 'null', '-']);
    } catch { return resolve(false); }
    p.on('error', () => resolve(false));
    p.on('close', code => resolve(code === 0));
  });
}

let CAPS = null;   // { available, menu:[{id,label}], recommended, profiles:Map }
async function detectCaps() {
  const results = await Promise.all(RAW_ENCODERS.map(probeEncoder));
  const available = {};
  RAW_ENCODERS.forEach((id, i) => { available[id] = results[i]; });
  const profs = buildProfiles(available);
  const profilesById = new Map(profs.map(p => [p.id, p]));
  const menu = profs.map(p => ({ id: p.id, label: p.label }));
  // recommend the fastest option: GPU if present, else fast H.264
  const recommended = (profs.find(p => p.id === 'gpu') ||
                       profs.find(p => p.id === 'h264fast') || profs[0])?.id;
  CAPS = { available, menu, recommended, profiles: profilesById };
  return CAPS;
}

// ---------------------------------------------------------------------------
// ffprobe helpers
// ---------------------------------------------------------------------------
function ffprobe(args) {
  return new Promise(resolve => {
    const p = spawn('ffprobe', args);
    let out = '';
    p.stdout.on('data', d => out += d);
    p.on('error', () => resolve(''));
    p.on('close', () => resolve(out.trim()));
  });
}
async function probeInput(file) {
  const dur = parseFloat(await ffprobe(['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', file])) || 0;
  let frames = parseInt(await ffprobe(['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_frames', '-of', 'csv=p=0', file]), 10);
  if (!Number.isFinite(frames) || frames <= 0) frames = 0;
  return { duration: dur, frames };
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------
const jobs = new Map();   // id -> { input, output, opts, name, ... }

function buildFfmpegArgs(job) {
  const { input, output, opts } = job;
  const filters = [];
  if (opts.dedupe !== 'off' && DEDUPE[opts.dedupe]) filters.push(DEDUPE[opts.dedupe]);
  filters.push('format=yuv420p');
  const vf = filters.join(',');

  const profile = CAPS.profiles.get(opts.encoder) || CAPS.profiles.get(CAPS.recommended);
  job.encoderUsed = profile.codec;
  const encArgs = profile.build(opts.level).map(String);

  return [
    '-y', '-hide_banner', '-loglevel', 'error', '-nostats',
    '-i', input,
    '-vf', vf,
    '-fps_mode', 'vfr',
    ...encArgs,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    output,
  ];
}

function runJob(job, onEvent) {
  const args = buildFfmpegArgs(job);
  job.proc = spawn('ffmpeg', args);
  let stderr = '';
  let buf = '';
  let lastFrame = 0;

  job.proc.stdout.on('data', chunk => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    let progressed = false, ended = false, secs = 0;
    for (const line of lines) {
      const [k, v] = line.split('=');
      if (k === 'frame') { lastFrame = parseInt(v, 10) || lastFrame; progressed = true; }
      else if (k === 'out_time_us') { secs = (parseInt(v, 10) || 0) / 1e6; progressed = true; }
      else if (k === 'progress' && v === 'end') ended = true;
    }
    if (progressed) {
      const pct = job.duration > 0 ? Math.min(99, (secs / job.duration) * 100) : null;
      onEvent({ type: 'progress', percent: pct, seconds: secs, frame: lastFrame });
    }
    if (ended) job.outFrames = lastFrame;
  });

  job.proc.stderr.on('data', d => { stderr += d; });

  job.proc.on('error', err => onEvent({ type: 'error', message: 'ffmpeg failed to start: ' + err.message }));

  job.proc.on('close', async code => {
    if (code !== 0) {
      onEvent({ type: 'error', message: (stderr.trim().split('\n').slice(-3).join(' ') || `ffmpeg exited ${code}`) });
      return;
    }
    let after = 0;
    try { after = (await fs.stat(job.output)).size; } catch {}
    job.done = true;
    onEvent({
      type: 'done',
      before: job.inputSize,
      after,
      saved: job.inputSize > 0 ? (100 * (job.inputSize - after) / job.inputSize) : 0,
      srcFrames: job.frames,
      outFrames: job.outFrames || lastFrame,
      dedupe: job.opts.dedupe,
      encoder: job.encoderUsed,
      downloadUrl: `/jobs/${job.id}/file`,
    });
  });
}

async function cleanupJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  try { job.proc?.kill('SIGKILL'); } catch {}
  for (const f of [job.input, job.output]) { try { await fs.unlink(f); } catch {} }
  jobs.delete(id);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4' };

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  // --- capabilities ---
  if (req.method === 'GET' && p === '/capabilities') {
    return sendJSON(res, 200, CAPS || await detectCaps());
  }

  // --- upload + create job:  POST /jobs?name=..&level=..&dedupe=..&encoder=.. (raw body = file) ---
  if (req.method === 'POST' && p === '/jobs') {
    const id = randomUUID();
    const name = url.searchParams.get('name') || 'video.mp4';
    const opts = {
      level:   LEVELS.includes(url.searchParams.get('level')) ? url.searchParams.get('level') : 'high',
      dedupe:  DEDUPE[url.searchParams.get('dedupe')] !== undefined ? url.searchParams.get('dedupe') : 'normal',
      encoder: url.searchParams.get('encoder') || CAPS?.recommended,
    };
    const ext = (path.extname(name) || '.mp4').toLowerCase();
    const input = path.join(TMP, `${id}-in${ext}`);
    const output = path.join(TMP, `${id}-out.mp4`);

    const ws = createWriteStream(input);
    req.pipe(ws);
    ws.on('error', () => sendJSON(res, 500, { error: 'upload write failed' }));
    ws.on('finish', async () => {
      let inputSize = 0;
      try { inputSize = (await fs.stat(input)).size; } catch {}
      const { duration, frames } = await probeInput(input);
      jobs.set(id, { id, input, output, opts, name, inputSize, duration, frames });
      sendJSON(res, 200, { id, inputSize, duration, frames });
    });
    return;
  }

  // --- progress stream + start:  GET /jobs/:id/events (SSE) ---
  let m = p.match(/^\/jobs\/([\w-]+)\/events$/);
  if (req.method === 'GET' && m) {
    const job = jobs.get(m[1]);
    if (!job) { res.writeHead(404); return res.end('no job'); }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ type: 'start', duration: job.duration, frames: job.frames, inputSize: job.inputSize });
    runJob(job, ev => {
      send(ev);
      if (ev.type === 'done' || ev.type === 'error') res.end();
    });
    req.on('close', () => { if (!job.done) cleanupJob(job.id); });
    return;
  }

  // --- download result:  GET /jobs/:id/file ---
  m = p.match(/^\/jobs\/([\w-]+)\/file$/);
  if (req.method === 'GET' && m) {
    const job = jobs.get(m[1]);
    if (!job || !job.done) { res.writeHead(404); return res.end('not ready'); }
    const dlName = job.name.replace(/\.[^.]+$/, '') + '.compressed.mp4';
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="${dlName}"`,
    });
    const rs = createReadStream(job.output);
    rs.pipe(res);
    rs.on('end', () => setTimeout(() => cleanupJob(job.id), 60_000)); // keep briefly for re-download
    rs.on('error', () => { res.destroy(); });
    return;
  }

  // --- static frontend ---
  if (req.method === 'GET') return serveStatic(res, p);

  res.writeHead(405); res.end('method not allowed');
});

await detectCaps();
// Bind on all local interfaces (dual-stack) so both http://localhost (IPv6 ::1)
// and http://127.0.0.1 (IPv4) reach it regardless of how the browser resolves.
server.listen(PORT, () => {
  const avail = Object.entries(CAPS.available).filter(([, v]) => v).map(([k]) => k);
  console.log(`Smart Video Compressor (native) running at http://localhost:${PORT}`);
  console.log(`Working encoders: ${avail.join(', ') || 'none?!'}`);
  console.log(`Recommended: ${CAPS.recommended}`);
  // Open the browser only once we're actually listening (set by the launcher).
  if (process.env.OPEN_BROWSER) {
    const url = `http://127.0.0.1:${PORT}/`;
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
              : process.platform === 'darwin' ? ['open', [url]]
              : ['xdg-open', [url]];
    try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch {}
  }
});
