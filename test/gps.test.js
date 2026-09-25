'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { freeGpsBox, voidFreeGpsBox, rmcSentence, drive } = require('./fixtures');
const { parseNmeaText } = require('../src/gps/nmea');
const { parseGpx } = require('../src/gps/gpx');
const { loadTrackForVideo, loadTrackFile } = require('../src/gps');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dashcam-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const close = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b}`);

test('NMEA RMC parsing with checksum and hemispheres', () => {
  const pts = parseNmeaText([
    '$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A',
    '$GPRMC,123520,V,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*7D', // void fix
    '$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*00', // bad checksum
    rmcSentence({ lat: -33.8568, lon: 151.2153, kmh: 50, date: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)) }),
  ].join('\n'));
  assert.strictEqual(pts.length, 2);
  close(pts[0].lat, 48.1173);
  close(pts[0].lon, 11.516667);
  close(pts[0].speed, 22.4 * 1.852);
  assert.strictEqual(pts[0].timestamp, Date.UTC(1994, 2, 23, 12, 35, 19));
  close(pts[1].lat, -33.8568);
  close(pts[1].lon, 151.2153);
  assert.strictEqual(pts[1].timestamp, Date.UTC(2026, 0, 2, 3, 4, 5));
});

test('GPX parsing', () => {
  const pts = parseGpx(`<?xml version="1.0"?><gpx><trk><trkseg>
    <trkpt lat="10.5" lon="-20.25"><time>2026-09-24T12:00:00Z</time><speed>10</speed></trkpt>
    <trkpt lon="-20.26" lat="10.51"/>
  </trkseg></trk></gpx>`);
  assert.strictEqual(pts.length, 2);
  assert.deepStrictEqual([pts[0].lat, pts[0].lon, pts[0].speed], [10.5, -20.25, 36]);
  assert.strictEqual(pts[0].timestamp, Date.parse('2026-09-24T12:00:00Z'));
  assert.deepStrictEqual([pts[1].lat, pts[1].lon, pts[1].timestamp], [10.51, -20.26, null]);
});

test('Novatek freeGPS boxes embedded in a fake MP4, across chunk boundaries', async () => {
  const fixes = drive(40);
  const junk = (n) => Buffer.alloc(n, 0xab);
  // ~1 MB of filler between boxes forces several of them to straddle the 8 MB chunk edge.
  const parts = [Buffer.from('\0\0\0\x18ftypisom'), junk(100)];
  fixes.forEach((f, i) => parts.push(freeGpsBox(f), junk(1024 * 1024 - 37 * i)));
  const file = path.join(tmp, 'novatek.mp4');
  fs.writeFileSync(file, Buffer.concat(parts));

  const track = await loadTrackForVideo(file);
  assert.strictEqual(track.source, 'embedded: Novatek freeGPS');
  assert.strictEqual(track.timing, 'record');
  assert.strictEqual(track.points.length, fixes.length);
  track.points.forEach((p, i) => {
    close(p.lat, fixes[i].lat);
    close(p.lon, fixes[i].lon);
    close(p.speed, fixes[i].kmh, 0.01);
    assert.strictEqual(p.t, i);
  });
});

test('Novatek: fixes are placed by record index, not GPS time (no-fix records, repeated seconds)', async () => {
  // Mirrors a real Viofo-style file: 5 s without a fix, a repeated GPS second, then a 4 s dropout.
  const fixes = drive(20);
  fixes[7].date = fixes[6].date; // camera clock vs GPS: same GPS second written twice
  const layout = [
    ...Array(5).fill(null),          // records 0-4: no fix yet
    ...fixes.slice(0, 12),           // records 5-16
    ...Array(4).fill(null),          // records 17-20: dropout
    ...fixes.slice(12),              // records 21-28
  ];
  const file = path.join(tmp, 'dropout.mp4');
  fs.writeFileSync(file, Buffer.concat(layout.map((f) => (f ? freeGpsBox(f) : voidFreeGpsBox()))));

  const track = await loadTrackForVideo(file);
  assert.strictEqual(track.timing, 'record');
  assert.deepStrictEqual(track.stats, { records: 29, noFix: 9 });
  assert.strictEqual(track.points.length, 20); // the repeated GPS second is kept
  assert.deepStrictEqual(track.points.map((p) => p.t),
    [...Array.from({ length: 12 }, (_, i) => 5 + i), ...Array.from({ length: 8 }, (_, i) => 21 + i)]);
  close(track.points[0].lat, fixes[0].lat);
  close(track.points[12].lat, fixes[12].lat);
});

test('GPX videoTime extension overrides timestamp timing', async () => {
  const file = path.join(tmp, 'clip.gpx');
  fs.writeFileSync(file, `<gpx xmlns:dtv="urn:dashcam-track-viewer"><trk><trkseg>
    <trkpt lat="1" lon="2"><time>2026-01-01T00:00:10Z</time><extensions><dtv:videoTime>22.000</dtv:videoTime></extensions></trkpt>
    <trkpt lat="1.001" lon="2"><time>2026-01-01T00:00:10Z</time><extensions><dtv:videoTime>23.000</dtv:videoTime></extensions></trkpt>
    <trkpt lat="1.002" lon="2"><time>2026-01-01T00:00:11Z</time><extensions><dtv:videoTime>24.000</dtv:videoTime></extensions></trkpt>
  </trkseg></trk></gpx>`);
  const track = await loadTrackFile(file);
  assert.strictEqual(track.timing, 'record');
  assert.deepStrictEqual(track.points.map((p) => p.t), [22, 23, 24]);
});

const REAL = path.join(__dirname, '..', 'samples', '2025_0629_100230_941.MP4');
test('real sample: 600 records, first 32 s without fix', { skip: !fs.existsSync(REAL) && 'sample not present' }, async () => {
  const track = await loadTrackForVideo(REAL, null, { readSidecar: false, writeCache: false });
  assert.deepStrictEqual(track.stats, { records: 600, noFix: 32 });
  assert.strictEqual(track.points.length, 568);
  assert.strictEqual(track.points[0].t, 32);
  assert.strictEqual(track.points.at(-1).t, 599);
});

test('scanned GPS is cached as GPX and reused on the next load', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'cache-'));
  const video = path.join(dir, '2025_0629_100230_941.MP4');
  const fixes = drive(6);
  fs.writeFileSync(video, Buffer.concat([voidFreeGpsBox(), voidFreeGpsBox(), ...fixes.map(freeGpsBox)]));

  const first = await loadTrackForVideo(video);
  assert.strictEqual(first.source, 'embedded: Novatek freeGPS');
  assert.strictEqual(first.cachePath, path.join(dir, '2025_0629_100230_941.gpx'));
  assert.ok(fs.existsSync(first.cachePath));

  // Make the video unscannable: the second load must come from the cache alone.
  fs.writeFileSync(video, Buffer.alloc(1000));
  const second = await loadTrackForVideo(video);
  assert.strictEqual(second.cached, true);
  assert.strictEqual(second.source, 'embedded: Novatek freeGPS (cached in 2025_0629_100230_941.gpx)');
  assert.deepStrictEqual(second.stats, first.stats); // { records: 8, noFix: 2 } survives
  assert.deepStrictEqual(second.stats, { records: 8, noFix: 2 });
  assert.strictEqual(second.timing, 'record');
  assert.deepStrictEqual(second.points.map((p) => p.t), first.points.map((p) => p.t));
  second.points.forEach((p, i) => {
    close(p.lat, first.points[i].lat, 1e-6);
    close(p.speed, first.points[i].speed, 0.01);
    assert.strictEqual(p.timestamp, first.points[i].timestamp);
  });
});

test('a cache older than its video is rescanned and rewritten; user GPX is never replaced', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'stale-'));
  const video = path.join(dir, 'clip.mp4');
  fs.writeFileSync(video, Buffer.concat(drive(3).map(freeGpsBox)));
  const first = await loadTrackForVideo(video);
  assert.strictEqual(first.points.length, 3);

  // Video re-recorded after the cache was written.
  fs.writeFileSync(video, Buffer.concat(drive(5).map(freeGpsBox)));
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(video, future, future);
  const second = await loadTrackForVideo(video);
  assert.strictEqual(second.cached, undefined);
  assert.strictEqual(second.points.length, 5);
  assert.strictEqual((await loadTrackForVideo(video)).cached, undefined, 'cache rewritten but still older than the future-dated video');
  fs.utimesSync(video, new Date(0), new Date(0));
  const third = await loadTrackForVideo(video);
  assert.strictEqual(third.cached, true);
  assert.strictEqual(third.points.length, 5);

  // A user's own GPX (no dtv:source) is used even when older than the video.
  const own = path.join(dir, 'mine.mp4');
  fs.writeFileSync(own, Buffer.concat(drive(3).map(freeGpsBox)));
  fs.writeFileSync(path.join(dir, 'mine.gpx'), '<gpx><trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="1.1" lon="2"/></trkseg></trk></gpx>');
  fs.utimesSync(own, future, future);
  const user = await loadTrackForVideo(own);
  assert.strictEqual(user.source, 'sidecar: mine.gpx');
});

test('cache is not written when the folder is read-only', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'ro-'));
  const video = path.join(dir, 'clip.mp4');
  fs.writeFileSync(video, Buffer.concat(drive(3).map(freeGpsBox)));
  fs.chmodSync(dir, 0o555);
  try {
    const track = await loadTrackForVideo(video);
    assert.strictEqual(track.points.length, 3);
    assert.ok(track.cacheError, 'expected a cache error');
    assert.strictEqual(track.cachePath, undefined);
  } finally {
    fs.chmodSync(dir, 0o755);
  }
});

test('Embedded NMEA sentences in a binary file', async () => {
  const fixes = drive(10, { lat: 40.7128, lon: -74.006 });
  const parts = [Buffer.alloc(5000, 0)];
  fixes.forEach((f) => parts.push(Buffer.from(rmcSentence(f) + '\r\n'), Buffer.alloc(3000, 0x11)));
  const file = path.join(tmp, 'nmea.mov');
  fs.writeFileSync(file, Buffer.concat(parts));

  const track = await loadTrackForVideo(file);
  assert.strictEqual(track.source, 'embedded: NMEA');
  assert.strictEqual(track.points.length, 10);
  close(track.points[9].lat, fixes[9].lat);
  close(track.points[9].lon, fixes[9].lon);
  assert.strictEqual(track.points[9].t, 9);
});

test('Sidecar GPX takes precedence and standalone track files load', async () => {
  const video = path.join(tmp, 'CLIP0001.MP4');
  fs.writeFileSync(video, Buffer.concat([freeGpsBox(drive(1)[0])]));
  fs.writeFileSync(path.join(tmp, 'CLIP0001.gpx'),
    '<gpx><trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="1.001" lon="2.001"/></trkseg></trk></gpx>');
  const track = await loadTrackForVideo(video);
  assert.strictEqual(track.source, 'sidecar: CLIP0001.gpx');
  assert.strictEqual(track.timing, 'index');
  assert.deepStrictEqual(track.points.map((p) => p.t), [0, 1]);

  const nmeaFile = path.join(tmp, 'log.nmea');
  fs.writeFileSync(nmeaFile, drive(5).map(rmcSentence).join('\n'));
  assert.strictEqual((await loadTrackFile(nmeaFile)).points.length, 5);
});

test('Video with no GPS yields an empty track', async () => {
  const file = path.join(tmp, 'nogps.mp4');
  fs.writeFileSync(file, Buffer.alloc(20000, 0x33));
  const track = await loadTrackForVideo(file);
  assert.strictEqual(track.points.length, 0);
  assert.strictEqual(track.source, 'none');
});
