'use strict';

// Incident candidates from a track's GPS speed/heading.
//
// Dashcam GPS is ~1 Hz, which is enough to see *braking* and *swerving* but not the
// ~100 ms spike of an impact itself (the camera's G-sensor sees that, but cameras like
// the Viofo/Novatek ones here don't store its readings). So these events point at
// "where the driving got abrupt", which is usually right next to the incident.
//
// Points: { t (s into video), speed (km/h), heading (deg), lat, lon }.
// Events: { type, label, severity, t, tEnd, peak (m/s²), g, fromKmh, toKmh, lat, lon }
//   t = when it started (jump target, minus some lead-in), peak/lat/lon at the sharpest second.

const G = 9.81;
const GAP_S = 3;              // same dropout rule as the renderer
const BRAKE = 0.3 * G;        // hard braking: ≥ 0.3 g over some 1–3 s window
const SEVERE = 0.45 * G;      // ... severe at ≥ 0.45 g
const STOP_KMH = 5;           // braking that ends below this is a "hard stop"
const SPIKE_KMH = 8;          // a dip that recovers by more than this next second is a GPS glitch
const SWERVE = 0.4 * G;       // lateral acceleration (v · turn rate)
const SWERVE_MIN_KMH = 25;    // heading is too noisy to trust below this

const rad = Math.PI / 180;
const turn = (a, b) => ((b - a + 540) % 360) - 180;

function bearing(a, b) {
  const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) -
    Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

/** Merge overlapping [start, end] candidate windows into events. */
function mergeWindows(windows) {
  const out = [];
  for (const w of windows.sort((a, b) => a.i - b.i)) {
    const last = out[out.length - 1];
    if (last && w.i <= last.j) {
      last.j = Math.max(last.j, w.j);
      if (Math.abs(w.a) > Math.abs(last.a)) Object.assign(last, { a: w.a, at: w.at });
    } else {
      out.push({ ...w });
    }
  }
  return out;
}

function hardBraking(pts) {
  const windows = [];
  for (let i = 0; i < pts.length; i++) {
    for (let w = 1; w <= 3 && i + w < pts.length; w++) {
      const j = i + w;
      let ok = pts[i].speed != null && pts[j].speed != null;
      for (let k = i + 1; ok && k <= j; k++) ok = pts[k].t - pts[k - 1].t <= GAP_S && pts[k].speed != null;
      if (!ok) break;
      const a = (pts[j].speed - pts[i].speed) / 3.6 / (pts[j].t - pts[i].t);
      if (a > -BRAKE) continue;
      // A single-sample dip that bounces straight back is a GPS glitch, not braking.
      const after = pts[j + 1];
      if (after && after.speed != null && after.t - pts[j].t <= GAP_S && after.speed > pts[j].speed + SPIKE_KMH) continue;
      // Sharpest single second inside the window, for peak / location.
      let at = i + 1, sharpest = 0;
      for (let k = i + 1; k <= j; k++) {
        const ak = (pts[k].speed - pts[k - 1].speed) / 3.6 / (pts[k].t - pts[k - 1].t);
        if (ak < sharpest) { sharpest = ak; at = k; }
      }
      windows.push({ i, j, a: Math.min(a, sharpest), at });
    }
  }
  return mergeWindows(windows).map(({ i, j, a, at }) => {
    const peak = -a;
    const stop = pts[j].speed <= STOP_KMH;
    return {
      type: stop ? 'hard-stop' : 'hard-braking',
      label: stop ? 'Hard stop' : 'Hard braking',
      severity: peak >= SEVERE ? 'severe' : 'hard',
      t: pts[i].t,
      tEnd: pts[j].t,
      peak,
      g: peak / G,
      fromKmh: pts[i].speed,
      toKmh: pts[j].speed,
      lat: pts[at].lat,
      lon: pts[at].lon,
    };
  });
}

function swerves(pts) {
  const windows = [];
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1], b = pts[k];
    const dt = b.t - a.t;
    if (dt <= 0 || dt > 1.5 || a.speed == null || b.speed == null) continue;
    if (a.speed < SWERVE_MIN_KMH || b.speed < SWERVE_MIN_KMH) continue;
    const ha = a.heading ?? (k >= 2 ? bearing(pts[k - 2], a) : null);
    const hb = b.heading ?? bearing(a, b);
    if (ha == null || hb == null) continue;
    const lateral = ((a.speed + b.speed) / 2 / 3.6) * (turn(ha, hb) * rad) / dt;
    if (Math.abs(lateral) >= SWERVE) windows.push({ i: k - 1, j: k, a: lateral, at: k });
  }
  return mergeWindows(windows).map(({ i, j, a, at }) => ({
    type: 'swerve',
    label: `Swerve ${a > 0 ? 'right' : 'left'}`,
    severity: Math.abs(a) >= SEVERE ? 'severe' : 'hard',
    t: pts[i].t,
    tEnd: pts[j].t,
    peak: Math.abs(a),
    g: Math.abs(a) / G,
    fromKmh: pts[i].speed,
    toKmh: pts[j].speed,
    lat: pts[at].lat,
    lon: pts[at].lon,
  }));
}

/** All incident candidates in a track, in time order. */
function detectEvents(points) {
  const pts = points.filter((p) => Number.isFinite(p.t));
  if (pts.length < 2) return [];
  return [...hardBraking(pts), ...swerves(pts)].sort((a, b) => a.t - b.t);
}

// Folders dashcams move event-locked recordings into (Viofo: RO; others: Event, EMR, ...).
const LOCKED_DIRS = new Set(['ro', 'event', 'events', 'emr', 'protected', 'lock', 'locked', 'parking_event']);
const isLockedPath = (filePath) => LOCKED_DIRS.has(require('path').basename(require('path').dirname(filePath)).toLowerCase());

module.exports = { detectEvents, isLockedPath, thresholds: { BRAKE, SEVERE, SWERVE, SWERVE_MIN_KMH } };
