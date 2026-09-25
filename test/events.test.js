'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { detectEvents, isLockedPath } = require('../src/gps/events');
const { loadTrackForVideo } = require('../src/gps');

/** 1 Hz points along a straight line north from a speed profile (km/h), heading 0. */
function track(speeds, { heading = () => 0, gaps = [] } = {}) {
  let lat = 41.3, t = 0;
  return speeds.map((speed, i) => {
    if (gaps.includes(i)) t += 10;
    const p = { t, speed, heading: heading(i), lat, lon: -75.6 };
    lat += (speed / 3.6) / 111320;
    t += 1;
    return p;
  });
}
const cruise = (n, v) => Array(n).fill(v);

test('steady driving and gentle slowing produce no events', () => {
  assert.deepStrictEqual(detectEvents(track([...cruise(20, 100), 95, 90, 85, 80, 75, ...cruise(10, 75)])), []); // ~0.14 g
});

test('hard braking is detected once, with peak, speeds and location', () => {
  const pts = track([...cruise(10, 96), 86, 75, 62, 52, ...cruise(10, 52)]); // like the real 0.37 g stop
  const ev = detectEvents(pts);
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].type, 'hard-braking');
  assert.strictEqual(ev[0].severity, 'hard');
  assert.ok(ev[0].g > 0.33 && ev[0].g < 0.4, `g ${ev[0].g}`);
  assert.strictEqual(ev[0].fromKmh, 96);
  assert.strictEqual(ev[0].toKmh, 52);
  assert.ok(ev[0].t >= 9 && ev[0].t <= 10 && ev[0].tEnd === 13, `t ${ev[0].t}-${ev[0].tEnd}`);
  assert.strictEqual(ev[0].lat, pts.find((p) => p.t === 12).lat); // sharpest second: 75 → 62
});

test('braking to a standstill is a severe hard stop', () => {
  const ev = detectEvents(track([...cruise(10, 60), 40, 18, 2, ...cruise(5, 0)]));
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].type, 'hard-stop');
  assert.strictEqual(ev[0].severity, 'severe');
});

test('a one-sample GPS speed glitch is ignored', () => {
  assert.deepStrictEqual(detectEvents(track([...cruise(10, 90), 60, ...cruise(10, 90)])), []);
});

test('no braking is inferred across a GPS dropout', () => {
  // 100 km/h before a 10 s gap, 40 after: could be anything, so no event.
  assert.deepStrictEqual(detectEvents(track([...cruise(10, 100), ...cruise(10, 40)], { gaps: [10] })), []);
});

test('a swerve at speed is detected; the same heading change crawling is not', () => {
  const swerve = (v) => track(cruise(15, v), { heading: (i) => (i === 8 ? 20 : 0) });
  const fast = detectEvents(swerve(70)); // 19.4 m/s * 0.35 rad/s ≈ 0.69 g
  assert.ok(fast.some((e) => e.type === 'swerve' && e.label === 'Swerve right'), JSON.stringify(fast));
  assert.deepStrictEqual(detectEvents(swerve(15)), []);
});

test('locked-folder detection', () => {
  assert.ok(isLockedPath('/media/sd/DCIM/Movie/RO/2024_0409_124252_417.MP4'));
  assert.ok(isLockedPath('D:\\DCIM\\EMR\\clip.mp4'.replace(/\\/g, '/')));
  assert.ok(!isLockedPath('/media/sd/DCIM/Movie/2024_0409_124252_417.MP4'));
});

const SAMPLES = path.join(__dirname, '..', 'samples');
for (const [file, from, to] of [['2024_0409_124252_417.MP4', 289, 290], ['2025_0629_100230_941.MP4', 317, 321]]) {
  const f = path.join(SAMPLES, file);
  test(`real sample ${file}: one hard-braking event at ${from}-${to} s`, { skip: !fs.existsSync(f) && 'sample not present' }, async () => {
    const t = await loadTrackForVideo(f, null, { readSidecar: false, writeCache: false });
    const ev = detectEvents(t.points);
    assert.strictEqual(ev.length, 1, JSON.stringify(ev));
    assert.deepStrictEqual([ev[0].type, ev[0].t, ev[0].tEnd], ['hard-braking', from, to]);
  });
}
