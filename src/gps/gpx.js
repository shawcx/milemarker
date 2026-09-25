'use strict';

// Minimal GPX reader: pulls <trkpt>/<rtept> lat, lon, <time>, <speed>, <course>.
// Regex-based to avoid an XML dependency; good enough for typical GPX exports.
// Also reads our own <dtv:videoTime> element (seconds into the video), written with
// exported clips so their track stays in sync even across GPS dropouts.

const PT_RE = /<(?:trkpt|rtept)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:trkpt|rtept)>)/g;

function attr(attrs, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`).exec(attrs);
  return m ? parseFloat(m[1]) : NaN;
}

function tag(body, name) {
  const m = new RegExp(`<(?:\\w+:)?${name}>([^<]*)</(?:\\w+:)?${name}>`).exec(body || '');
  return m ? m[1].trim() : null;
}

function parseGpx(text) {
  const points = [];
  let m;
  PT_RE.lastIndex = 0;
  while ((m = PT_RE.exec(text))) {
    const lat = attr(m[1], 'lat');
    const lon = attr(m[1], 'lon');
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const time = tag(m[2], 'time');
    const speed = parseFloat(tag(m[2], 'speed')); // m/s per GPX 1.0 / extensions
    const course = parseFloat(tag(m[2], 'course'));
    const ts = time ? Date.parse(time) : NaN;
    const videoTime = parseFloat(tag(m[2], 'videoTime'));
    points.push({
      ...(Number.isFinite(videoTime) ? { t: videoTime } : {}),
      lat,
      lon,
      speed: Number.isFinite(speed) ? speed * 3.6 : null,
      heading: Number.isFinite(course) ? course : null,
      timestamp: Number.isFinite(ts) ? ts : null,
    });
  }
  return points;
}

/** Our own metadata from a GPX we wrote: { source, records } (fields absent if not ours). */
function parseGpxMeta(text) {
  const meta = text.slice(0, Math.max(0, text.search(/<trk[\s>]/)) || 4000);
  const source = tag(meta, 'source');
  const records = parseInt(tag(meta, 'records'), 10);
  return {
    ...(source ? { source: unescapeXml(source) } : {}),
    ...(Number.isFinite(records) ? { records } : {}),
  };
}

const escapeXml = (x) => String(x).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
const unescapeXml = (x) => x.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/**
 * Serialise track points ({ lat, lon, speed km/h, heading, timestamp, t }) as GPX 1.0.
 * `t` (seconds into the video) is kept in a <dtv:videoTime> element so the track stays in
 * sync on reload. <time> is only written for fixes that have a real GPS timestamp.
 */
function writeGpx(points, { name = '', source, records } = {}) {
  const rows = points.map((p) => {
    return `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">` +
      (p.timestamp != null ? `<time>${new Date(Math.round(p.timestamp)).toISOString()}</time>` : '') +
      (p.speed != null ? `<speed>${(p.speed / 3.6).toFixed(3)}</speed>` : '') +
      (p.heading != null ? `<course>${p.heading.toFixed(1)}</course>` : '') +
      (Number.isFinite(p.t) ? `<dtv:videoTime>${p.t.toFixed(3)}</dtv:videoTime>` : '') +
      '</trkpt>';
  });
  // GPX 1.0 has no <metadata>/<extensions>; it allows foreign-namespace elements inline.
  const ext = [
    source ? `  <dtv:source>${escapeXml(source)}</dtv:source>\n` : '',
    Number.isFinite(records) ? `  <dtv:records>${records}</dtv:records>\n` : '',
  ].join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.0" creator="Dashcam Track Viewer" xmlns="http://www.topografix.com/GPX/1/0" xmlns:dtv="urn:dashcam-track-viewer">
  <name>${escapeXml(name)}</name>
${ext}  <trk>
    <name>${escapeXml(name)}</name>
    <trkseg>
${rows.join('\n')}
    </trkseg>
  </trk>
</gpx>
`;
}

module.exports = { parseGpx, parseGpxMeta, writeGpx };
