'use strict';

// Generates samples/synthetic.mp4: a test-pattern video (with audio) and Novatek-style
// freeGPS boxes appended as top-level 'free' boxes (players ignore them).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { freeGpsBox, drive } = require('../test/fixtures');
const { FFMPEG } = require('../src/clip');

// Usage: node scripts/make-sample.js [seconds] [--trip N]
//   --trip N writes N consecutive clips (samples/trip/TRIP_0001.mp4 ...) whose GPS continues
//   from one clip to the next, like a dashcam splitting a drive into files.
const args = process.argv.slice(2);
const tripIdx = args.indexOf('--trip');
const clips = tripIdx >= 0 ? Math.max(1, +args[tripIdx + 1] || 3) : 1;
const secs = +args.find((a, i) => !a.startsWith('--') && i !== tripIdx + 1) || 60;

// Audio: an engine-ish hum whose loudness swells and fades, plus a little noise.
const hum = '0.5*sin(2*PI*110*t)*(0.15+0.85*abs(sin(t/3)))+0.03*(random(0)-0.5)';

for (let c = 0; c < clips; c++) {
  const out = clips === 1
    ? path.join(__dirname, '..', 'samples', 'synthetic.mp4')
    : path.join(__dirname, '..', 'samples', 'trip', `TRIP_${String(c + 1).padStart(4, '0')}.mp4`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30:duration=${secs}`,
    '-f', 'lavfi', '-i', `aevalsrc=${hum}:s=44100:d=${secs}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', out], { stdio: 'inherit' });
  const boxes = drive(secs, undefined, c * secs).map(freeGpsBox);
  fs.appendFileSync(out, Buffer.concat(boxes));
  fs.rmSync(out.replace(/\.mp4$/, '.gpx'), { force: true }); // drop the app's GPS cache for the old file
  console.log(`wrote ${out} with ${boxes.length} GPS fixes`);
}
