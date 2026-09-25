'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { FFMPEG, FFPROBE, keyframeAtOrBefore, runExport } = require('../src/clip');

let hasFfmpeg = true;
try { execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' }); } catch { hasFfmpeg = false; }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dashcam-clip-'));
const src = path.join(tmp, 'src.mp4');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const duration = (f) => parseFloat(execFileSync(FFPROBE,
  ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());

test('uses the bundled binaries from node_modules', () => {
  assert.match(FFMPEG, /node_modules[\\/]ffmpeg-static/);
  assert.match(FFPROBE, /node_modules[\\/]@ffprobe-installer/);
});

test('clip export', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async (t) => {
  // 10 s, 30 fps, keyframe every 50 frames (0, 1.667, 3.333, 5, ...) with an audio track.
  execFileSync(FFMPEG, ['-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
    '-c:v', 'libx264', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', src]);

  await t.test('snaps to the keyframe at or before the in-point', async () => {
    const near = (a, b) => assert.ok(Math.abs(a - b) < 0.01, `${a} !≈ ${b}`);
    near(await keyframeAtOrBefore(src, 3.3), 50 / 30);
    near(await keyframeAtOrBefore(src, 4), 100 / 30);
    near(await keyframeAtOrBefore(src, 5), 5);
    assert.strictEqual(await keyframeAtOrBefore(src, 0.5), 0);
  });

  await t.test('fast mode copies from a fractional keyframe', async () => {
    const dest = path.join(tmp, 'fast.mp4');
    const progress = [];
    const start = await keyframeAtOrBefore(src, 4); // 3.333…, rounds *below* the keyframe at 3 d.p.
    await runExport({ src, dest, start, end: 6, mode: 'fast' }, (p) => progress.push(p)).promise;
    assert.ok(Math.abs(duration(dest) - (6 - start)) < 0.15, `duration ${duration(dest)}`);
    assert.ok(progress.length > 0);
  });

  await t.test('precise mode re-encodes from an arbitrary frame', async () => {
    const dest = path.join(tmp, 'precise.mp4');
    await runExport({ src, dest, start: 3.3, end: 4.8, mode: 'precise' }).promise;
    assert.ok(Math.abs(duration(dest) - 1.5) < 0.1, `duration ${duration(dest)}`);
  });

  await t.test('cancel rejects with cancelled flag', async () => {
    const job = runExport({ src, dest: path.join(tmp, 'cancel.mp4'), start: 0, end: 10, mode: 'precise' });
    job.cancel();
    await assert.rejects(job.promise, (err) => err.cancelled === true);
  });

  await t.test('ffmpeg errors are surfaced', async () => {
    const job = runExport({ src: path.join(tmp, 'missing.mp4'), dest: path.join(tmp, 'x.mp4'), start: 0, end: 1, mode: 'fast' });
    await assert.rejects(job.promise, /ffmpeg exited with code/);
  });
});
