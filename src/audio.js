'use strict';

// Audio waveform peaks for the timeline. ffmpeg decodes the first audio stream to
// 8 kHz mono s16le on stdout; we reduce it on the fly to one peak (0..1) per bucket.

const { execFile, spawn } = require('child_process');
const { FFMPEG, FFPROBE } = require('./clip');

const SAMPLE_RATE = 8000;

function hasAudio(file) {
  return new Promise((resolve, reject) => {
    execFile(FFPROBE, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=index', '-of', 'csv=p=0', file],
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim() !== '')));
  });
}

/**
 * Returns { promise, cancel }. The promise resolves to
 *   { rate, peaks: Float32Array } (rate = buckets per second), or null when the file has no audio.
 */
function audioPeaks(file, { rate = 100 } = {}) {
  let proc = null;
  let cancelled = false;

  const promise = (async () => {
    const audible = await hasAudio(file);
    if (cancelled) throw Object.assign(new Error('cancelled'), { cancelled: true });
    if (!audible) return null;
    const bucket = Math.round(SAMPLE_RATE / rate);
    const peaks = [];
    let cur = 0, n = 0, carry = null;

    proc = spawn(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE),
      '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1']);
    proc.stdout.on('data', (chunk) => {
      if (carry) { chunk = Buffer.concat([carry, chunk]); carry = null; }
      const even = chunk.length & ~1;
      for (let i = 0; i < even; i += 2) {
        const v = Math.abs(chunk.readInt16LE(i));
        if (v > cur) cur = v;
        if (++n === bucket) { peaks.push(cur / 32768); cur = 0; n = 0; }
      }
      if (even < chunk.length) carry = chunk.subarray(even);
    });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });

    await new Promise((resolve, reject) => {
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (cancelled) reject(Object.assign(new Error('cancelled'), { cancelled: true }));
        else if (code === 0) resolve();
        else reject(new Error(`ffmpeg audio decode failed (${code}): ${stderr.trim().split('\n').pop()}`));
      });
    });
    if (n) peaks.push(cur / 32768);
    return { rate, peaks: Float32Array.from(peaks) };
  })();

  return { promise, cancel: () => { cancelled = true; proc?.kill('SIGKILL'); } };
}

module.exports = { audioPeaks, hasAudio };
