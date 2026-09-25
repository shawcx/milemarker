'use strict';

// Parses NMEA 0183 RMC sentences ($GPRMC, $GNRMC, ...) into track points.

const RMC_RE = /\$(G[PNLA])RMC,([^*\r\n]*)(?:\*([0-9A-Fa-f]{2}))?/g;

function checksumOk(body, expected) {
  if (!expected) return true;
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum ^= body.charCodeAt(i);
  return sum === parseInt(expected, 16);
}

// "4916.45" + "N" -> 49.274166...
function nmeaCoord(value, hemi) {
  if (!value) return null;
  const v = parseFloat(value);
  if (!Number.isFinite(v)) return null;
  const deg = Math.floor(v / 100);
  const dec = deg + (v - deg * 100) / 60;
  return hemi === 'S' || hemi === 'W' ? -dec : dec;
}

function parseRmcFields(fields) {
  const [time, status, lat, latH, lon, lonH, knots, course, date] = fields;
  if (status !== 'A') return null;
  const la = nmeaCoord(lat, latH);
  const lo = nmeaCoord(lon, lonH);
  if (la == null || lo == null) return null;

  let timestamp = null;
  if (time && time.length >= 6 && date && date.length === 6) {
    const yy = +date.slice(4, 6);
    const ms = Date.UTC(
      yy < 80 ? 2000 + yy : 1900 + yy, +date.slice(2, 4) - 1, +date.slice(0, 2),
      +time.slice(0, 2), +time.slice(2, 4), parseFloat(time.slice(4))
    );
    if (Number.isFinite(ms)) timestamp = ms;
  }
  const kn = parseFloat(knots);
  const hd = parseFloat(course);
  return {
    lat: la,
    lon: lo,
    speed: Number.isFinite(kn) ? kn * 1.852 : null,
    heading: Number.isFinite(hd) ? hd : null,
    timestamp,
  };
}

/** Extract all valid RMC fixes from a text blob. */
function parseNmeaText(text) {
  const points = [];
  RMC_RE.lastIndex = 0;
  let m;
  while ((m = RMC_RE.exec(text))) {
    const body = `${m[1]}RMC,${m[2]}`;
    if (!checksumOk(body, m[3])) continue;
    const p = parseRmcFields(m[2].split(','));
    if (p) points.push(p);
  }
  return points;
}

module.exports = { parseNmeaText, nmeaCoord };
