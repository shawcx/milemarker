'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { FFMPEG } = require('../src/clip');
const { audioPeaks } = require('../src/audio');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dashcam-audio-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const video = ['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=2'];

test('peaks follow loudness: 1 s silence then a half-scale tone', async () => {
  const file = path.join(tmp, 'tone.mp4');
  execFileSync(FFMPEG, ['-loglevel', 'error', '-y', ...video,
    '-f', 'lavfi', '-i', 'aevalsrc=if(gte(t\\,1)\\,0.5*sin(2*PI*200*t)\\,0):s=8000:d=2',
    '-c:v', 'libx264', '-c:a', 'pcm_s16le', '-shortest', file.replace('.mp4', '.mov')]);
  const res = await audioPeaks(file.replace('.mp4', '.mov')).promise;
  assert.strictEqual(res.rate, 100);
  assert.ok(Math.abs(res.peaks.length - 200) <= 2, `length ${res.peaks.length}`);
  const avg = (a, b) => res.peaks.slice(a, b).reduce((x, y) => x + y, 0) / (b - a);
  assert.ok(avg(10, 90) < 0.01, `silence avg ${avg(10, 90)}`);
  assert.ok(Math.abs(avg(110, 190) - 0.5) < 0.03, `tone avg ${avg(110, 190)}`);
});

test('video without audio resolves to null', async () => {
  const file = path.join(tmp, 'silent.mp4');
  execFileSync(FFMPEG, ['-loglevel', 'error', '-y', ...video, '-c:v', 'libx264', file]);
  assert.strictEqual(await audioPeaks(file).promise, null);
});

test('cancel rejects with cancelled flag', async () => {
  const file = path.join(tmp, 'long.mp4');
  execFileSync(FFMPEG, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=30',
    '-f', 'lavfi', '-i', 'sine=frequency=300:duration=30', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', file]);
  const job = audioPeaks(file);
  job.cancel();
  await assert.rejects(job.promise, (err) => err.cancelled === true);
});
