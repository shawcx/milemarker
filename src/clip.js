'use strict';

// Clip export via ffmpeg/ffprobe. Where the binaries come from, first match wins:
//   1. FFMPEG_PATH / FFPROBE_PATH
//   2. the packaged app's resources/ffmpeg/ (per-platform, see scripts/fetch-ffmpeg.js)
//   3. the npm packages used in development (ffmpeg-static, @ffprobe-installer/ffprobe)
//   4. whatever is on PATH
//
// Two modes:
//   fast    - stream copy. Near-instant, lossless, but must start on a keyframe,
//             so the start is snapped back to the nearest keyframe at/before the
//             requested in-point.
//   precise - re-encode (H.264/AAC). Frame-accurate, slower.

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function packaged(tool) {
  if (!process.resourcesPath) return null; // plain Node (tests, scripts)
  const p = path.join(process.resourcesPath, 'ffmpeg', tool + (process.platform === 'win32' ? '.exe' : ''));
  return fs.existsSync(p) ? p : null;
}

function fromNpm(load) {
  try {
    return load() || null;
  } catch {
    return null; // not installed (e.g. packaged app, where these are dev-only)
  }
}

const FFMPEG = process.env.FFMPEG_PATH || packaged('ffmpeg') || fromNpm(() => require('ffmpeg-static')) || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || packaged('ffprobe') ||
  fromNpm(() => require('@ffprobe-installer/ffprobe').path) || 'ffprobe';

function probe(args) {
  return new Promise((resolve, reject) => {
    execFile(FFPROBE, ['-v', 'error', ...args], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err.code === 'ENOENT' ? new Error(`ffprobe not found (${FFPROBE}) — run npm install or set FFPROBE_PATH`) : err);
      else resolve(stdout);
    });
  });
}

/** Latest keyframe time (seconds from file start) at or before `t`. */
async function keyframeAtOrBefore(file, t) {
  const startOut = await probe(['-show_entries', 'format=start_time', '-of', 'csv=p=0', file]);
  const origin = parseFloat(startOut) || 0;
  const abs = origin + t;
  const out = await probe([
    '-select_streams', 'v:0', '-skip_frame', 'nokey',
    '-read_intervals', `${Math.max(0, abs - 15)}%${abs + 0.001}`,
    '-show_entries', 'frame=pts_time,best_effort_timestamp_time', '-of', 'csv=p=0', file,
  ]);
  let best = null;
  for (const line of out.split('\n')) {
    const k = line.split(',').map(parseFloat).find(Number.isFinite);
    if (k != null && k <= abs + 0.001 && (best == null || k > best)) best = k;
  }
  return best == null ? t : Math.max(0, best - origin);
}

function ffmpegArgs({ src, dest, start, end, mode }) {
  // In copy mode `start` is a keyframe time; round up so we don't land just before
  // it (ffmpeg would then seek back to the previous keyframe).
  const ss = mode === 'precise' ? start.toFixed(3) : (Math.ceil(start * 1000) / 1000).toFixed(3);
  const common = ['-hide_banner', '-nostats', '-y', '-ss', ss, '-i', src, '-t', (end - start).toFixed(3),
    '-map', '0:v:0', '-map', '0:a:0?'];
  const codec = mode === 'precise'
    ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k']
    : ['-c', 'copy'];
  return [...common, ...codec, '-movflags', '+faststart', '-progress', 'pipe:1', dest];
}

/**
 * Run ffmpeg. Returns { promise, cancel }. `onProgress` gets 0..1.
 */
function runExport(opts, onProgress) {
  const duration = opts.end - opts.start;
  const proc = spawn(FFMPEG, ffmpegArgs(opts));
  let stderr = '';
  let cancelled = false;

  proc.stdout.on('data', (d) => {
    const m = /out_time_us=(\d+)/.exec(d.toString().split('\n').filter((l) => l.startsWith('out_time_us=')).pop() || '');
    if (m) onProgress?.(Math.min(1, +m[1] / 1e6 / duration));
  });
  proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });

  const promise = new Promise((resolve, reject) => {
    proc.on('error', (err) => reject(err.code === 'ENOENT' ? new Error(`ffmpeg not found (${FFMPEG}) — run npm install or set FFMPEG_PATH`) : err));
    proc.on('close', (code) => {
      if (cancelled) reject(Object.assign(new Error('Export cancelled'), { cancelled: true }));
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });

  return { promise, cancel: () => { cancelled = true; proc.kill('SIGKILL'); } };
}

module.exports = { FFMPEG, FFPROBE, keyframeAtOrBefore, ffmpegArgs, runExport };
