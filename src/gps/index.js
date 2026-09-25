'use strict';

// Entry point for GPS extraction. Given a video file, tries (in order):
//   1. Sidecar files next to the video (same basename .gpx / .nmea / .log / .txt).
//      This includes the GPX cache we write after scanning a video (step 4).
//   2. Novatek "freeGPS" boxes embedded in the MP4/MOV
//   3. Raw NMEA $xxRMC sentences embedded anywhere in the file
//   4. Whatever 2/3 found is saved as <video basename>.gpx so the next load skips the scan.
//
// Every extractor returns points shaped as
//   { lat, lon, speed (km/h|null), heading (deg|null), timestamp (ms UTC|null), t? }
// and finalizeTrack() ensures `t`, the offset in seconds from the start of the video.
// Sources that know where each fix sits in the video (Novatek: one record per second
// of video) set `t` themselves; otherwise it's derived from the GPS timestamps.

const fs = require('fs');
const path = require('path');
const { parseNmeaText } = require('./nmea');
const { parseGpx, parseGpxMeta, writeGpx } = require('./gpx');
const novatek = require('./novatek');

const CHUNK = 8 * 1024 * 1024;
const OVERLAP = 512; // must exceed the largest record we parse across a chunk edge
const RMC = Buffer.from('RMC,', 'latin1');

/** Single streaming pass over the file collecting freeGPS boxes and NMEA RMC sentences. */
async function scanVideo(filePath, onProgress) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    const buf = Buffer.alloc(CHUNK);
    const freeGps = [];
    let freeGpsRecords = 0; // including records without a fix
    const nmeaLines = [];
    let pos = 0;

    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
      if (bytesRead === 0) break;
      const atEof = pos + bytesRead >= size;
      // Matches starting in the overlap tail are handled by the next chunk.
      const scanEnd = atEof ? bytesRead : bytesRead - OVERLAP;
      const view = buf.subarray(0, bytesRead);

      for (let i = view.indexOf(novatek.MARKER); i !== -1 && i < scanEnd; i = view.indexOf(novatek.MARKER, i + 1)) {
        if (i < 4) continue;
        // The camera writes one record per second of video, fix or not, so the
        // record's index *is* its video time. (GPS timestamps drift vs. the video
        // clock and sometimes repeat or skip a second.)
        const p = novatek.parseFreeGpsBox(view.subarray(i - 4, i - 4 + 256));
        if (p) freeGps.push({ ...p, t: freeGpsRecords });
        freeGpsRecords++;
      }

      for (let i = view.indexOf(RMC); i !== -1 && i < scanEnd; i = view.indexOf(RMC, i + 1)) {
        const start = i - 3; // "$GP" / "$GN" ...
        if (start < 0 || view[start] !== 0x24 /* $ */) continue;
        let end = i;
        while (end < view.length && end - start < 120 && view[end] >= 0x20 && view[end] < 0x7f) end++;
        nmeaLines.push(view.toString('latin1', start, end));
      }

      onProgress?.(Math.min(1, (pos + bytesRead) / size));
      if (atEof) break;
      pos += bytesRead - OVERLAP;
    }

    return { freeGps, freeGpsRecords, nmea: parseNmeaText(nmeaLines.join('\n')) };
  } finally {
    await fh.close();
  }
}

function parseTrackText(filePath, text) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.gpx' || /<gpx[\s>]/i.test(text.slice(0, 2000))) return parseGpx(text);
  return parseNmeaText(text);
}

async function findSidecar(videoPath) {
  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath)).toLowerCase();
  let entries;
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return null;
  }
  const exts = ['.gpx', '.nmea', '.log', '.txt'];
  for (const ext of exts) {
    const hit = entries.find((e) => e.toLowerCase() === base + ext);
    if (hit) return path.join(dir, hit);
  }
  return null;
}

/**
 * Drop duplicate / out-of-order fixes and ensure `t` (seconds into video).
 * `records` is how many samples the source holds including ones without a fix.
 */
function finalizeTrack(points, source, { records = points.length } = {}) {
  const stats = { records, noFix: records - points.length };

  // Source already placed each fix on the video timeline.
  if (points.length && points.every((p) => Number.isFinite(p.t))) {
    const clean = [];
    for (const p of [...points].sort((a, b) => a.t - b.t)) {
      if (clean.length && p.t === clean[clean.length - 1].t) continue;
      clean.push(p);
    }
    return { source, timing: 'record', points: clean, stats };
  }

  const clean = [];
  for (const p of points) {
    const prev = clean[clean.length - 1];
    if (prev && p.timestamp != null && prev.timestamp != null && p.timestamp <= prev.timestamp) continue;
    clean.push(p);
  }

  const timed = clean.length > 1 && clean.every((p) => p.timestamp != null);
  const t0 = timed ? clean[0].timestamp : 0;
  clean.forEach((p, i) => {
    p.t = timed ? (p.timestamp - t0) / 1000 : i; // untimed: assume 1 Hz
  });

  return { source, timing: timed ? 'timestamp' : 'index', points: clean, stats };
}

const cachePathFor = (videoPath) =>
  path.join(path.dirname(videoPath), `${path.basename(videoPath, path.extname(videoPath))}.gpx`);

/**
 * `readSidecar` / `writeCache` (default true) let callers force a fresh scan without touching disk.
 */
async function loadTrackForVideo(videoPath, onProgress, { readSidecar = true, writeCache = true } = {}) {
  const sidecar = readSidecar ? await findSidecar(videoPath) : null;
  let staleCache = false;
  if (sidecar) {
    const text = await fs.promises.readFile(sidecar, 'utf8');
    const pts = parseTrackText(sidecar, text);
    // A GPX we wrote remembers where its data came from and how many records the video had.
    const meta = sidecar.toLowerCase().endsWith('.gpx') ? parseGpxMeta(text) : {};
    // Our own cache is stale if the video changed after it was written; user sidecars always win.
    if (meta.source) {
      const [v, c] = await Promise.all([fs.promises.stat(videoPath), fs.promises.stat(sidecar)]);
      staleCache = v.mtimeMs > c.mtimeMs;
    }
    if (pts.length && !staleCache) {
      const source = meta.source ? `${meta.source} (cached in ${path.basename(sidecar)})` : `sidecar: ${path.basename(sidecar)}`;
      return { ...finalizeTrack(pts, source, { records: meta.records ?? pts.length }), cached: true };
    }
  }

  const { freeGps, freeGpsRecords, nmea } = await scanVideo(videoPath, onProgress);
  let track;
  if (freeGps.length) track = finalizeTrack(freeGps, 'embedded: Novatek freeGPS', { records: freeGpsRecords });
  else if (nmea.length) track = finalizeTrack(nmea, 'embedded: NMEA');
  else return finalizeTrack([], 'none');
  if (!writeCache) return track;

  // Cache next to the video. Failure (read-only folder, etc.) just means we rescan next time.
  const cachePath = cachePathFor(videoPath);
  try {
    await fs.promises.writeFile(cachePath, writeGpx(track.points, {
      name: path.basename(videoPath), source: track.source, records: track.stats.records,
    }), { flag: staleCache ? 'w' : 'wx' }); // only overwrite our own stale cache
    track.cachePath = cachePath;
  } catch (err) {
    track.cacheError = err.message;
  }
  return track;
}

async function loadTrackFile(filePath) {
  const text = await fs.promises.readFile(filePath, 'utf8');
  const pts = parseTrackText(filePath, text);
  // A GPX we wrote (cache or clip export) knows its origin and how many records had no fix.
  const meta = filePath.toLowerCase().endsWith('.gpx') ? parseGpxMeta(text) : {};
  const name = path.basename(filePath);
  return finalizeTrack(pts, meta.source ? `${meta.source} (from ${name})` : name, { records: meta.records ?? pts.length });
}

module.exports = { loadTrackForVideo, loadTrackFile, scanVideo, finalizeTrack, cachePathFor };
