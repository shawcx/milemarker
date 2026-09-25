'use strict';

/* global L */

const $ = (id) => document.getElementById(id);
const video = $('video');
const gauge = createGauge($('gauge')); // eslint-disable-line no-undef

// Speeds are stored in km/h everywhere; units only affect display.
const UNITS = {
  kmh: { label: 'km/h', factor: 1 },
  mph: { label: 'mph', factor: 1 / 1.609344 },
};
const loadUnits = () => { try { return UNITS[localStorage.getItem('units')] ? localStorage.getItem('units') : 'kmh'; } catch { return 'kmh'; } };

const state = {
  videos: [],     // the trip: [{ videoPath, videoUrl, name, track }] in playback order
  current: -1,    // index into the trip (videos, or GPS-only tracks) of the one shown
  tracks: [],      // GPS files opened without video: [{ name, track }] in name order
  points: [],   // current track's [{ t, lat, lon, speed, heading, timestamp }]
  offset: 0,    // seconds added to video time to get track time
  follow: true,
  clipIn: null,  // video seconds; null = start of video
  clipOut: null, // null = end of video
  overview: true,  // map shows the whole trip; Follow only takes over once the user zooms in / asks
  units: loadUnits(),
  maxSpeed: 0,     // trip's top speed, km/h
  events: [],      // trip-wide incident candidates: [{ vi (track index), ...event }] in trip order
  eventIdx: -1,    // the one last jumped to
};
const unit = () => UNITS[state.units];
const toUnit = (kmh) => (kmh == null ? null : kmh * unit().factor);

const chart = createSpeedChart($('speed-chart'), { onSeek: seekTo, onEvent: (k) => jumpToEvent(k) }); // eslint-disable-line no-undef
const wave = createWaveform($('waveform'), { onSeek: seekTo }); // eslint-disable-line no-undef
let audioRequest = 0; // ignores results for a video that's since been replaced

// ---------------------------------------------------------------- map setup

// zoomSnap 0: fractional zoom, so a window resize can scale the view exactly (see below).
// trackResize off: we handle window resizes ourselves.
const map = L.map('map', { preferCanvas: true, zoomControl: false, zoomSnap: 0, trackResize: false }).setView([20, 0], 2);
L.control.zoom({ position: 'topright' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
L.control.scale({ imperial: false, position: 'topright' }).addTo(map);

// Declared before the panel: it reports its initial layout while being created.
let panelReady = false;
let windowResizing = false;
let lastView = null; // see "window resize" below

const panel = createFloatingPanel($('panel'), { // eslint-disable-line no-undef
  header: $('panel-header'),
  grip: $('panel-resize'),
  collapsible: $('meta'),
  collapseBtn: $('btn-meta'),
  onChange: ({ byUser }) => {
    if (!panelReady || windowResizing) return;
    if (following()) updatePosition();
    // Only a deliberate panel move changes "the area I'm looking at"; automatic clamping doesn't.
    if (byUser) rememberView();
  },
});
panelReady = true;

/** Largest part of the map not covered by the panel (container px). */
function freeRect() {
  const { x: W, y: H } = map.getSize();
  const p = panel.rect();
  const candidates = [
    { x: 0, y: 0, w: p.left, h: H },
    { x: p.right, y: 0, w: W - p.right, h: H },
    { x: 0, y: 0, w: W, h: p.top },
    { x: 0, y: p.bottom, w: W, h: H - p.bottom },
  ];
  return candidates.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
}

// ---------------------------------------------------------------- window resize

// The map area the user is looking at (the part not under the panel), kept up to date so a
// window resize can show the same area, scaled, instead of Leaflet's default (same zoom,
// more/less map).
function rememberView() {
  if (windowResizing) return;
  const f = freeRect();
  if (f.w < 1 || f.h < 1) return;
  lastView = L.latLngBounds(map.containerPointToLatLng([f.x, f.y]), map.containerPointToLatLng([f.x + f.w, f.y + f.h]));
}
map.on('moveend', rememberView);

let resizeFrame = 0;
window.addEventListener('resize', () => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    const view = lastView;
    windowResizing = true;
    try {
      panel.fitWindow();
      map.invalidateSize({ pan: false });
      if (view) {
        const f = freeRect(), size = map.getSize();
        map.fitBounds(view, {
          paddingTopLeft: [f.x, f.y],
          paddingBottomRight: [size.x - f.x - f.w, size.y - f.y - f.h],
          animate: false,
        });
      }
      if (following()) updatePosition();
    } finally {
      windowResizing = false;
    }
    // Keep the pre-resize area (not a re-measured one) so repeated resizes don't drift.
    lastView = view;
  });
});

/** Put `latlng` at the centre of the free area without animating. */
function centerOn(latlng, zoom = map.getZoom()) {
  const f = freeRect();
  const size = map.getSize();
  const offset = L.point(f.x + f.w / 2 - size.x / 2, f.y + f.h / 2 - size.y / 2);
  map.setView(map.unproject(map.project(latlng, zoom).subtract(offset), zoom), zoom, { animate: false });
}

const trackLayer = L.layerGroup().addTo(map);
const clipLayer = L.layerGroup().addTo(map); // selected clip range, drawn behind the track
const eventLayer = L.layerGroup().addTo(map); // incident markers
const eventIcon = L.divIcon({
  className: 'ev-marker',
  iconSize: [24, 22],
  iconAnchor: [12, 20],
  html: '<svg width="24" height="22" viewBox="0 0 16 16"><path d="M8 1.5 15 14H1z"/><path class="ev-bang" d="M8 6v3.6M8 11.4v.4"/></svg>',
});
const carIcon = L.divIcon({
  className: 'car-icon',
  iconSize: [28, 28],
  iconAnchor: [14, 14],
  html: '<svg width="28" height="28" viewBox="0 0 28 28"><g><circle cx="14" cy="14" r="11" fill="#3b8eea" stroke="#fff" stroke-width="2.5"/><path d="M14 6 L19 18 L14 15 L9 18 Z" fill="#fff"/></g></svg>',
});
let carMarker = null;

// The map starts on the whole-trip overview, even while playing. Follow (keep the
// vehicle centred) only takes over when the user zooms in, ticks Follow, or clicks the track.
function following() { return state.follow && !state.overview; } // declared, not const: the panel calls it during setup
function engageFollow() {
  if (!state.follow || !state.overview) return;
  state.overview = false;
  if (!zooming) updatePosition();
}

// Disable follow when the user drags the map themselves.
map.on('dragstart', () => setFollow(false));
let zooming = false;
map.on('zoomstart', () => { zooming = true; });
map.on('zoomend', () => { zooming = false; if (following()) updatePosition(); });

const clampZoom = (z) => Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), z));
/** With Follow on, zoom around the vehicle; zooming in also starts following. */
function zoomFollowing(delta) {
  if (delta > 0) engageFollow();
  const zoom = clampZoom(map.getZoom() + delta);
  if (zoom !== map.getZoom()) map.setZoomAround(carMarker.getLatLng(), zoom);
}

let wheelAcc = 0;
map.getContainer().addEventListener('wheel', (e) => {
  if (!state.follow || !carMarker) return;
  e.preventDefault();
  e.stopPropagation();
  wheelAcc += e.deltaY;
  if (Math.abs(wheelAcc) < 60) return;
  const delta = -Math.sign(wheelAcc);
  wheelAcc = 0;
  zoomFollowing(delta);
}, { passive: false, capture: true });

// Double-click and the +/- buttons get the same treatment.
map.doubleClickZoom.disable();
map.on('dblclick', (e) => {
  if (state.follow && carMarker) zoomFollowing(e.originalEvent.shiftKey ? -1 : 1);
  else map.setZoomAround(e.latlng, clampZoom(map.getZoom() + (e.originalEvent.shiftKey ? -1 : 1)));
});
for (const [sel, delta] of [['.leaflet-control-zoom-in', 1], ['.leaflet-control-zoom-out', -1]]) {
  document.querySelector(sel).addEventListener('click', (e) => {
    if (!state.follow || !carMarker) return; // plain Leaflet zoom
    e.preventDefault();
    e.stopImmediatePropagation();
    zoomFollowing(delta);
  }, true);
}

// ---------------------------------------------------------------- helpers

// Speed colour ramp, as fractions of the trip's top speed. Used for the track and the legend.
const SPEED_STOPS = [
  [0, [31, 158, 63]],     // darker green  #1f9e3f
  [0.45, [236, 236, 19]], // bright yellow hsl(60, 85%, 50%)
  [0.8, [255, 36, 20]],   // bright red    #ff2414
  [1, [168, 0, 15]],      // deeper red    #a8000f
];

function speedColor(kmh, max) {
  const f = Math.max(0, Math.min(1, kmh / max));
  const i = Math.max(1, SPEED_STOPS.findIndex(([at]) => at >= f));
  const [a, ca] = SPEED_STOPS[i - 1], [b, cb] = SPEED_STOPS[i];
  const k = (f - a) / (b - a);
  return `rgb(${ca.map((c, j) => Math.round(c + (cb[j] - c) * k)).join(', ')})`;
}
const SPEED_GRADIENT = `linear-gradient(to right, ${SPEED_STOPS.map(([at, c]) => `rgb(${c.join(', ')}) ${at * 100}%`).join(', ')})`;

function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function bearing(a, b) {
  const rad = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) -
    Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

function lerpAngle(a, b, f) {
  const d = ((b - a + 540) % 360) - 180;
  return (a + d * f + 360) % 360;
}

function fmtDuration(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
}

// Fixes further apart than this (seconds) are a GPS dropout, not a stretch of road.
const GAP_S = 3;
const isGap = (a, b) => b.t - a.t > GAP_S;

/**
 * Interpolated state at track time `t`. Outside the track or inside a dropout it
 * returns the nearest earlier fix flagged `noFix`, so callers can show "no fix"
 * instead of inventing a position/speed.
 */
function sampleAt(t) {
  const pts = state.points;
  if (!pts.length) return null;
  const last = pts.length - 1;
  if (t < pts[0].t - 0.5) return { ...pts[0], index: 0, noFix: true };
  if (t > pts[last].t + 0.5) return { ...pts[last], index: last, noFix: true };
  if (t <= pts[0].t) return { ...pts[0], index: 0 };
  if (t >= pts[last].t) return { ...pts[last], index: last };

  let lo = 0, hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = pts[lo], b = pts[hi];
  if (isGap(a, b)) return { ...a, index: lo, noFix: true };
  const f = (t - a.t) / (b.t - a.t || 1);
  const ha = a.heading ?? bearing(a, b);
  const hb = b.heading ?? ha;
  return {
    lat: a.lat + (b.lat - a.lat) * f,
    lon: a.lon + (b.lon - a.lon) * f,
    speed: a.speed != null && b.speed != null ? a.speed + (b.speed - a.speed) * f : a.speed,
    heading: lerpAngle(ha, hb, f),
    timestamp: a.timestamp != null && b.timestamp != null ? a.timestamp + (b.timestamp - a.timestamp) * f : null,
    index: lo,
  };
}

// ---------------------------------------------------------------- rendering

/** One-time per-track prep: backfill headings, measure distance. */
function prepareTrack(track) {
  const pts = track.points;
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].heading == null && pts.length > 1) {
      const a = pts[Math.min(i, pts.length - 2)], b = pts[Math.min(i + 1, pts.length - 1)];
      pts[i].heading = bearing(a, b);
    }
  }
  track.dist = 0;
  for (let i = 1; i < pts.length; i++) if (!isGap(pts[i - 1], pts[i])) track.dist += haversine(pts[i - 1], pts[i]);
  return track;
}

/** Every track on the map: the trip's videos, or a standalone GPS file. */
const tripTracks = () => (state.videos.length ? state.videos : state.tracks).map((item) => item.track);
const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);

/** Draw the whole trip and fit the map to it. */
function drawTrip() {
  trackLayer.clearLayers();
  clipLayer.clearLayers();
  state.events = tripTracks().flatMap((t, vi) => (t.events || []).map((e) => ({ vi, ...e })));
  state.eventIdx = -1;
  drawEventMarkers();
  carMarker = null;
  const tracks = tripTracks().filter((t) => t.points.length);
  const all = tracks.flatMap((t) => t.points);
  const hasSpeed = all.some((p) => p.speed != null);
  state.maxSpeed = hasSpeed ? Math.max(30, ...all.map((p) => p.speed ?? 0)) : 0;
  $('legend').classList.toggle('hidden', !hasSpeed);
  document.body.classList.toggle('no-track', !all.length);
  if (!all.length) {
    updateTelemetry(null);
    gauge.show(false);
    return;
  }

  const dashed = (a, b) => L.polyline([[a.lat, a.lon], [b.lat, b.lon]],
    { color: '#5b636d', weight: 3, dashArray: '2 7', interactive: false }).addTo(trackLayer);
  tracks.forEach((track, ti) => {
    const pts = track.points;
    // Continuous runs; GPS dropouts, and the hop between consecutive videos, are drawn dashed.
    if (ti > 0) dashed(tracks[ti - 1].points.at(-1), pts[0]);
    const runs = [[pts[0]]];
    for (let i = 1; i < pts.length; i++) {
      if (isGap(pts[i - 1], pts[i])) { dashed(pts[i - 1], pts[i]); runs.push([]); }
      runs[runs.length - 1].push(pts[i]);
    }
    // Casing underneath for contrast against the map.
    for (const run of runs) {
      L.polyline(run.map((p) => [p.lat, p.lon]), { color: '#10141a', weight: 8, opacity: 0.55, interactive: false }).addTo(trackLayer);
    }
    for (let i = 1; i < pts.length; i++) {
      if (isGap(pts[i - 1], pts[i])) continue;
      const color = hasSpeed ? speedColor(((pts[i - 1].speed ?? 0) + (pts[i].speed ?? 0)) / 2, state.maxSpeed) : '#3b8eea';
      L.polyline([[pts[i - 1].lat, pts[i - 1].lon], [pts[i].lat, pts[i].lon]], { color, weight: 5, interactive: false }).addTo(trackLayer);
    }
  });

  // Trip markers: grey dot where each further file begins, white start, black end (on top).
  const named = tripItems().filter((item) => item.track.points.length);
  named.slice(1).forEach((item) => {
    const p = item.track.points[0];
    L.circleMarker([p.lat, p.lon], { radius: 6, color: '#fff', weight: 2, fillColor: '#8a9099', fillOpacity: 1 })
      .bindTooltip(item.name).addTo(trackLayer);
  });
  const first = all[0], last = all[all.length - 1];
  L.circleMarker([first.lat, first.lon], { radius: 9, color: '#1b1e22', weight: 2.5, fillColor: '#fff', fillOpacity: 1 })
    .bindTooltip('Start').addTo(trackLayer);
  L.circleMarker([last.lat, last.lon], { radius: 9, color: '#fff', weight: 2.5, fillColor: '#111', fillOpacity: 1 })
    .bindTooltip('End').addTo(trackLayer);
  carMarker = L.marker([first.lat, first.lon], { icon: carIcon, interactive: false, zIndexOffset: 1000 }).addTo(trackLayer);

  // Fit the trip into the area the panel leaves free. The panel may have just grown
  // (compact → video layout), so settle its position first.
  panel.reclamp();
  const f = freeRect(), size = map.getSize();
  state.overview = true;
  map.fitBounds(L.latLngBounds(all.map((p) => [p.lat, p.lon])), {
    paddingTopLeft: [f.x + 40, f.y + 40],
    paddingBottomRight: [size.x - f.x - f.w + 40, size.y - f.y - f.h + 40],
    maxZoom: 17,
  });
  applyUnits();
}

/** Make `track` the one driving telemetry, chart and clip tools; update the details line. */
function showTrack(track) {
  state.points = track?.points ?? [];
  const pts = state.points;
  if (!track) {
    $('i-source').textContent = '–';
  } else if (!pts.length) {
    $('i-source').textContent = 'No GPS data found in this file';
  } else {
    const noFix = track.stats?.noFix > 0 ? ` · ${track.stats.noFix} of ${track.stats.records} records without GPS fix` : '';
    $('i-source').textContent = track.source + (track.timing === 'index' ? ' (no timestamps, assuming 1 Hz)' : '') + noFix;
  }
  $('i-points').textContent = pts.length || '–';
  $('i-dist').textContent = pts.length ? fmtDist(track.dist) : '–';
  $('i-dur').textContent = pts.length ? fmtDuration(pts[pts.length - 1].t - pts[0].t) : '–';
  gauge.show(Boolean(video.src) && pts.some((p) => p.speed != null));
  refreshChart();
  updateEventsBar();
  updatePosition({ center: false });
  updateClipUi();
}

function applyUnits() {
  const u = unit();
  for (const b of document.querySelectorAll('.segmented button')) {
    b.setAttribute('aria-checked', String(b.dataset.unit === state.units));
  }
  $('t-speed-unit').textContent = u.label;
  gauge.setUnit(u.label);
  gauge.setMax(toUnit(state.maxSpeed || 30));
  chart.setUnits(u);
  const legend = $('legend');
  legend.replaceChildren();
  legend.append(`Speed (${u.label})`);
  legend.insertAdjacentHTML('beforeend', '<div class="bar"></div><div class="ends"><span>0</span><span></span></div>');
  legend.querySelector('.bar').style.background = SPEED_GRADIENT;
  legend.querySelector('.ends span:last-child').textContent = Math.round(toUnit(state.maxSpeed));
}

function setUnits(key) {
  state.units = key;
  try { localStorage.setItem('units', key); } catch { /* storage unavailable */ }
  applyUnits();
  if (state.points.length) updatePosition({ center: false });
  refreshChart();
  updateEventsBar();
  drawEventMarkers(); // their hover text includes speeds
}
for (const b of document.querySelectorAll('.segmented button')) {
  b.addEventListener('click', () => setUnits(b.dataset.unit));
}

/** Speed series in video time for the chart; x-range is the video, else the track. */
function refreshChart() {
  const pts = state.points;
  const series = [];
  pts.forEach((p, i) => {
    // A null point between dropout neighbours breaks the line.
    if (i && isGap(pts[i - 1], p)) series.push({ x: (pts[i - 1].t + p.t) / 2 - state.offset, y: null });
    series.push({ x: p.t - state.offset, y: p.speed });
  });
  const range = hasDuration() ? [0, video.duration]
    : pts.length ? [pts[0].t - state.offset, pts[pts.length - 1].t - state.offset] : null;
  chart.setData(series, range);
  chart.setEvents(state.events.map((ev, key) => ({ ev, key }))
    .filter(({ ev }) => ev.vi === Math.max(0, state.current))
    .map(({ ev, key }) => ({ x: ev.t - state.offset, label: eventText(ev), key })));
  wave.setDomain(range);
  updatePlayhead();
}

/** Decode audio in the background; the strip is only shown once we know there is sound. */
async function loadWaveform(videoPath) {
  const id = ++audioRequest;
  $('waveform').classList.add('hidden');
  try {
    const peaks = await window.dashcam.audioPeaks(videoPath);
    if (id !== audioRequest) return;
    $('waveform').classList.toggle('hidden', !wave.setData(peaks)); // false: no track, or silent
  } catch (err) {
    if (id === audioRequest) console.error('Audio decode failed:', err);
  }
}

/** Chart click: seek the video, or with no video just show that point. */
function seekTo(t) {
  if (hasDuration()) {
    video.currentTime = Math.max(0, Math.min(video.duration, t));
  } else if (state.points.length) {
    const s = sampleAt(t + state.offset);
    carMarker?.setLatLng([s.lat, s.lon]);
    updateTelemetry(s);
    chart.setPlayhead(t);
  }
}

function updateTelemetry(s) {
  if (s?.noFix) {
    for (const id of ['t-speed', 't-heading', 't-time']) $(id).textContent = '–';
    $('t-pos').textContent = 'no GPS fix';
    gauge.setSpeed(null);
    return;
  }
  $('t-speed').textContent = s?.speed != null ? toUnit(s.speed).toFixed(0) : '–';
  gauge.setSpeed(toUnit(s?.speed));
  $('t-heading').textContent = s?.heading != null ? s.heading.toFixed(0) : '–';
  $('t-time').textContent = s?.timestamp != null ? new Date(s.timestamp).toISOString().replace('T', ' ').slice(0, 19) : '–';
  $('t-pos').textContent = s ? `${s.lat.toFixed(6)}, ${s.lon.toFixed(6)}` : '–';
}

// Track `t` is seconds from the first fix; offset shifts GPS relative to video.
const trackTime = () => video.currentTime + state.offset;

function updatePosition({ center = true } = {}) {
  if (!carMarker || !state.points.length) return;
  const s = sampleAt(trackTime());
  carMarker.setLatLng([s.lat, s.lon]);
  carMarker.setOpacity(s.noFix ? 0.4 : 1);
  const svg = carMarker.getElement()?.querySelector('g');
  if (svg && s.heading != null) svg.setAttribute('transform', `rotate(${s.heading} 14 14)`);
  updateTelemetry(s);

  // Keep the vehicle centred. Skipped mid zoom-animation so we don't cancel it.
  if (center && following() && video.src && !zooming) centerOn([s.lat, s.lon]);
}

// Drive the marker from the video clock.
function frameLoop() {
  updatePosition();
  updatePlayhead();
  if (!video.paused && !video.ended) video.requestVideoFrameCallback(frameLoop);
}
video.addEventListener('play', () => video.requestVideoFrameCallback(frameLoop));
video.addEventListener('seeked', () => updatePosition());
video.addEventListener('timeupdate', () => {
  if (video.paused) updatePosition({ center: false });
  updatePlayhead();
});

// Click on (or near) the trip's track to jump there, switching video if needed.
map.on('click', (e) => {
  const target = map.latLngToLayerPoint(e.latlng);
  let best = null;
  tripTracks().forEach((track, vi) => track.points.forEach((p) => {
    const d = map.latLngToLayerPoint([p.lat, p.lon]).distanceTo(target);
    if (!best || d < best.d) best = { d, vi, p };
  }));
  if (!best || best.d > 25) return;
  engageFollow();
  const t = Math.max(0, best.p.t - state.offset);
  if (!state.videos.length) {
    if (best.vi !== state.current) showTrackItem(best.vi);
    seekTo(t);
  } else if (best.vi !== state.current) {
    showVideo(best.vi, { seek: t, autoplay: !video.paused });
  } else {
    video.currentTime = t;
  }
});

// ---------------------------------------------------------------- loading

function showOverlay(text, { cancellable = false } = {}) {
  $('btn-overlay-cancel').classList.toggle('hidden', !cancellable);
  $('overlay-text').textContent = text;
  $('progress-bar').style.width = '0';
  $('overlay').classList.remove('hidden');
}
const hideOverlay = () => $('overlay').classList.add('hidden');
window.dashcam.onScanProgress(({ index, count, name, progress }) => {
  $('overlay-text').textContent = count > 1 ? `Reading GPS data ${index + 1}/${count}: ${name}…` : `Reading GPS data: ${name}…`;
  $('progress-bar').style.width = `${Math.round(((index + progress) / count) * 100)}%`;
});

const currentVideo = () => state.videos[state.current] ?? null;

/** Trip items: the videos, or the GPS-only tracks. Both have { name, track }. */
const tripItems = () => (state.videos.length ? state.videos : state.tracks);

/** Common to switching item: title, trip bar position, clip reset. */
function selectItem(i, item, title) {
  state.current = i;
  state.clipIn = state.clipOut = null;
  setClipStatus('');
  $('file-name').textContent = item.name;
  $('file-name').title = title;
  $('sel-video').value = String(i);
  $('btn-prev').disabled = i === 0;
  $('btn-next').disabled = i === tripItems().length - 1;
}

/** Load video `i` of the trip into the player. */
function showVideo(i, { seek = 0, autoplay = true } = {}) {
  const v = state.videos[i];
  if (!v) return;
  selectItem(i, v, v.videoPath);
  video.src = v.videoUrl;
  if (seek) video.addEventListener('loadedmetadata', () => { video.currentTime = seek; }, { once: true });
  if (autoplay) video.play().catch((err) => console.warn('Autoplay failed:', err.message));
  loadWaveform(v.videoPath);
  showTrack(v.track);
}

/** Show GPS-only track `i`. */
function showTrackItem(i) {
  const t = state.tracks[i];
  if (!t) return;
  selectItem(i, t, t.name);
  showTrack(t.track);
}

/** Switch trip item (trip bar, map clicks, events), whichever kind the trip is. */
function showItem(i, opts) {
  if (state.videos.length) showVideo(i, opts);
  else showTrackItem(i);
}

// Continuous playback through the trip.
video.addEventListener('ended', () => {
  if (state.current < state.videos.length - 1) showVideo(state.current + 1);
});

/** Fill the trip bar (shown only for more than one item). */
function setupTripBar(items, noun) {
  const sel = $('sel-video');
  sel.replaceChildren(...items.map((item, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `${i + 1}/${items.length} · ${item.locked ? '🔒 ' : ''}${item.name}`;
    return o;
  }));
  sel.title = `${noun[0].toUpperCase()}${noun.slice(1)} in this trip`;
  const dist = items.reduce((sum, item) => sum + (item.track.dist || 0), 0);
  $('trip-summary').textContent = `${items.length} ${noun} · ${fmtDist(dist)}`;
  $('tripbar').classList.toggle('hidden', items.length < 2);
}

function loadTrip(videos) {
  state.videos = videos.map((v) => ({ ...v, track: prepareTrack(v.track) }));
  state.tracks = [];
  document.body.classList.remove('no-video');
  $('video-empty').classList.add('hidden');
  $('btn-fullscreen').classList.remove('hidden');
  setupTripBar(state.videos, 'videos');
  drawTrip();
  showVideo(0);
}

/** Take the video(s) out of the player and go back to the compact, video-less layout. */
function unloadVideos() {
  if (document.fullscreenElement) document.exitFullscreen();
  video.pause();
  video.removeAttribute('src');
  video.load();
  state.videos = [];
  state.current = -1;
  audioRequest++; // drop any waveform still decoding
  $('waveform').classList.add('hidden');
  $('video-empty').classList.remove('hidden');
  $('btn-fullscreen').classList.add('hidden');
  document.body.classList.add('no-video');
  gauge.show(false);
}

const baseName = (name) => name.replace(/\.[^.]+$/, '').toLowerCase();

/**
 * GPS file(s) opened. If every one matches an open video by name (X.gpx ↔ X.MP4), each
 * replaces that video's track. Otherwise the video(s) are unloaded and the files are shown
 * on their own, as a trip of tracks.
 */
function loadTrackFiles(items) {
  const matchOf = (item) => state.videos.find((v) => baseName(v.name) === baseName(item.name));
  if (state.videos.length && items.every(matchOf)) {
    for (const item of items) matchOf(item).track = prepareTrack(item.track);
    setupTripBar(state.videos, 'videos');
    drawTrip();
    showTrack(currentVideo().track);
    return;
  }
  if (state.videos.length) unloadVideos();
  state.tracks = items.map(({ name, track }) => ({ name, track: prepareTrack(track) }));
  setupTripBar(state.tracks, 'tracks');
  drawTrip();
  showTrackItem(0);
}

function applyResult(res) {
  if (res?.videos?.length) loadTrip(res.videos);
  else if (res?.tracks?.length) loadTrackFiles(res.tracks);
}

async function run(label, fn) {
  showOverlay(label);
  try {
    applyResult(await fn());
  } catch (err) {
    console.error(err);
    $('i-source').textContent = `Error: ${err.message}`;
  } finally {
    hideOverlay();
  }
}

$('btn-open-video').addEventListener('click', () => run('Reading GPS data…', window.dashcam.openVideo));
$('btn-open-track').addEventListener('click', () => run('Reading GPS files…', window.dashcam.openTrack));
window.dashcam.onOpenArgs((paths) => run('Reading GPS data…', () => window.dashcam.openPaths(paths)));
$('sel-video').addEventListener('change', (e) => showItem(Number(e.target.value), { autoplay: !video.paused }));
$('btn-prev').addEventListener('click', () => showItem(state.current - 1, { autoplay: !video.paused }));
$('btn-next').addEventListener('click', () => showItem(state.current + 1, { autoplay: !video.paused }));

function setFollow(on) {
  state.follow = on;
  $('chk-follow').checked = on;
}
$('chk-follow').addEventListener('change', (e) => {
  setFollow(e.target.checked);
  if (state.follow) { state.overview = false; updatePosition(); }
});
$('num-offset').addEventListener('input', (e) => {
  state.offset = parseFloat(e.target.value) || 0;
  updatePosition();
  refreshChart();
  updateClipUi();
});

// Drag & drop
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const paths = [...e.dataTransfer.files].map((f) => window.dashcam.pathForFile(f)).filter(Boolean);
  if (paths.length) run('Reading GPS data…', () => window.dashcam.openPaths(paths));
});

// ---------------------------------------------------------------- clip export

const fmtClock = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const hasDuration = () => Number.isFinite(video.duration) && video.duration > 0;
const clipStart = () => state.clipIn ?? 0;
const clipEnd = () => state.clipOut ?? (hasDuration() ? video.duration : 0);

function setClipStatus(text, isError = false) {
  const el = $('clip-status');
  el.textContent = text;
  el.title = text;
  el.classList.toggle('error', isError);
}

function updatePlayhead() {
  if (!hasDuration()) return;
  chart.setPlayhead(video.currentTime);
  wave.setPlayhead(video.currentTime);
}

function updateClipUi() {
  const ready = hasDuration();
  for (const id of ['btn-in', 'btn-out', 'btn-clip-clear', 'btn-export']) $(id).disabled = !ready;
  clipLayer.clearLayers();
  if (!ready) {
    $('clip-range').textContent = '–';
    chart.setClip(null);
    wave.setClip(null);
    return;
  }
  if (state.clipOut != null && state.clipOut > video.duration) state.clipOut = video.duration;
  const a = clipStart(), b = clipEnd();
  const custom = state.clipIn != null || state.clipOut != null;
  $('clip-range').textContent = `${fmtClock(a)}–${fmtClock(b)}`;
  $('clip-range').title = `Clip length ${(b - a).toFixed(1)} s`;
  chart.setClip(custom ? [a, b] : null);
  wave.setClip(custom ? [a, b] : null);
  updatePlayhead();

  // Highlight the clip's stretch of road, unless the clip is the whole video.
  if (state.points.length && custom) {
    const seg = clipTrack(a, b).map((p) => [p.lat, p.lon]);
    if (seg.length > 1) {
      L.polyline(seg, { color: '#ff4fd8', weight: 16, opacity: 0.6, interactive: false }).addTo(clipLayer).bringToBack();
    }
  }
}

function setClipIn(t) {
  state.clipIn = Math.min(t, clipEnd() - 0.1);
  updateClipUi();
}
function setClipOut(t) {
  state.clipOut = Math.max(t, clipStart() + 0.1);
  updateClipUi();
}

/** Track points covering video time [a, b], with interpolated end points. */
function clipTrack(a, b) {
  const pts = state.points;
  if (!pts.length) return [];
  const ta = a + state.offset, tb = b + state.offset;
  const out = [];
  if (ta >= pts[0].t) out.push({ ...sampleAt(ta), t: ta });
  for (const p of pts) if (p.t > ta && p.t < tb) out.push(p);
  if (tb <= pts[pts.length - 1].t) out.push({ ...sampleAt(tb), t: tb });
  return out;
}

async function exportClip() {
  if (!hasDuration()) return;
  const mode = $('sel-mode').value;
  video.pause();
  setClipStatus('');
  try {
    const { videoPath } = currentVideo();
    const plan = await window.dashcam.exportPrepare({ videoPath, start: clipStart(), end: clipEnd(), mode });
    if (!plan) return;
    const name = plan.dest.split(/[\\/]/).pop();
    // Clip's track with `t` re-based to the clip's own timeline.
    const gpxPoints = $('chk-gpx').checked
      ? clipTrack(plan.start, plan.end).map(({ lat, lon, speed, heading, timestamp, t }) =>
        ({ lat, lon, speed, heading, timestamp, t: Math.max(0, t - state.offset - plan.start) }))
      : null;
    showOverlay(`Exporting ${name}…`, { cancellable: true });
    const res = await window.dashcam.exportRun({ ...plan, videoPath, mode, gpxPoints });
    if (!res) return setClipStatus('Export cancelled');
    const shift = plan.start < clipStart() - 0.05 ? ` (starts ${(clipStart() - plan.start).toFixed(1)} s early at keyframe)` : '';
    setClipStatus(`Saved ${name}${res.gpxPath ? ' + .gpx' : ''}${shift}`);
  } catch (err) {
    console.error(err);
    setClipStatus(`Export failed: ${err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, true);
  } finally {
    hideOverlay();
  }
}

$('btn-in').addEventListener('click', () => setClipIn(video.currentTime));
$('btn-out').addEventListener('click', () => setClipOut(video.currentTime));
$('btn-clip-clear').addEventListener('click', () => { state.clipIn = state.clipOut = null; updateClipUi(); });
$('btn-export').addEventListener('click', exportClip);
$('btn-overlay-cancel').addEventListener('click', () => window.dashcam.exportCancel());
window.dashcam.onExportProgress((p) => { $('progress-bar').style.width = `${Math.round(p * 100)}%`; });
video.addEventListener('loadedmetadata', () => { refreshChart(); updateClipUi(); });
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'n' || e.key === 'N') stepEvent(1);
  else if (e.key === 'p' || e.key === 'P') stepEvent(-1);
  else if (e.key === 'i' || e.key === 'I') setClipIn(video.currentTime);
  else if (e.key === 'o' || e.key === 'O') setClipOut(video.currentTime);
});
updateClipUi();
applyUnits();

// ---------------------------------------------------------------- events

const EVENT_LEAD_S = 5;    // start playback this long before an event, to see the lead-up
const EVENT_CLIP_PRE = 10; // preset clip range around an event
const EVENT_CLIP_POST = 10;

function eventText(ev) {
  const u = unit();
  const speeds = `${Math.round(toUnit(ev.fromKmh))}→${Math.round(toUnit(ev.toKmh))} ${u.label}`;
  const where = state.videos.length > 1 ? ` · video ${ev.vi + 1}` : '';
  const sev = ev.severity === 'severe' ? ' (severe)' : '';
  return `${ev.label}${sev} · ${ev.g.toFixed(2)} g · ${speeds} · ${fmtClock(Math.max(0, ev.t - state.offset))}${where}`;
}

function drawEventMarkers() {
  eventLayer.clearLayers();
  state.events.forEach((ev, k) => {
    L.marker([ev.lat, ev.lon], { icon: eventIcon, zIndexOffset: 500, title: eventText(ev), keyboard: false })
      .on('click', () => jumpToEvent(k)).addTo(eventLayer);
  });
}

function updateEventsBar() {
  const bar = $('eventsbar');
  const hasTrack = tripTracks().some((t) => t.points.length);
  bar.classList.toggle('hidden', !hasTrack);
  $('ev-locked').classList.toggle('hidden', !currentVideo()?.locked);
  const n = state.events.length;
  bar.classList.toggle('none', n === 0);
  if (!n) {
    $('ev-label').textContent = 'No hard braking or swerves detected';
    $('ev-count').textContent = '';
    return;
  }
  const k = state.eventIdx;
  $('ev-label').textContent = k >= 0 ? eventText(state.events[k]) : `${n} event${n > 1 ? 's' : ''} detected: jump to the first`;
  $('ev-current').title = k >= 0 ? `${eventText(state.events[k])}: click to replay` : 'Jump to the first event';
  $('ev-count').textContent = k >= 0 ? `${k + 1}/${n}` : '';
  $('btn-ev-prev').disabled = k <= 0;
  $('btn-ev-next').disabled = k >= n - 1;
}

/** Jump to event k: a few seconds before it, clip range preset around it, map on it. */
function jumpToEvent(k) {
  const ev = state.events[k];
  if (!ev) return;
  state.eventIdx = k;
  const vt = ev.t - state.offset;
  if (state.videos.length) {
    const seek = Math.max(0, vt - EVENT_LEAD_S);
    if (ev.vi !== state.current) showVideo(ev.vi, { seek });
    else { video.currentTime = seek; video.play().catch(() => {}); }
    state.clipIn = Math.max(0, vt - EVENT_CLIP_PRE);
    state.clipOut = ev.tEnd - state.offset + EVENT_CLIP_POST;
    setClipStatus('');
    updateClipUi();
  } else {
    if (ev.vi !== state.current) showTrackItem(ev.vi);
    seekTo(vt);
  }
  // Show the spot at street level; with Follow on the vehicle then stays centred.
  if (state.follow) state.overview = false;
  centerOn([ev.lat, ev.lon], Math.max(map.getZoom(), 16));
  updateEventsBar();
}

function stepEvent(dir) {
  if (!state.events.length) return;
  jumpToEvent(Math.max(0, Math.min(state.events.length - 1, state.eventIdx < 0 ? 0 : state.eventIdx + dir)));
}

$('btn-ev-prev').addEventListener('click', () => stepEvent(-1));
$('btn-ev-next').addEventListener('click', () => stepEvent(1));
$('ev-current').addEventListener('click', () => jumpToEvent(Math.max(0, state.eventIdx)));

// ---------------------------------------------------------------- fullscreen

// Fullscreen the wrapper rather than the <video>, so the gauge overlay comes along.
const videoWrap = $('video-wrap');
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else if (video.src) videoWrap.requestFullscreen().catch((err) => console.error(err));
}
$('btn-fullscreen').addEventListener('click', toggleFullscreen);
// Replace the native double-click-to-fullscreen (which would drop the overlay).
video.addEventListener('dblclick', (e) => { e.preventDefault(); toggleFullscreen(); });
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'f' || e.key === 'F') toggleFullscreen();
});
// Safety net: if something still fullscreens the bare video, hand over to the wrapper.
document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement === video) document.exitFullscreen().then(() => videoWrap.requestFullscreen());
});

video.addEventListener('error', () => {
  $('i-source').textContent += ' — video could not be decoded (codec unsupported?)';
});
