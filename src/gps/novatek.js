'use strict';

// Novatek-chipset dashcams (Viofo, many no-name brands) store one GPS fix per
// second in MP4 'free' boxes whose payload starts with "freeGPS ". Layout
// varies by firmware, but the common ones share a core structure:
//
//   int32le hour, min, sec, year(-2000), month, day
//   char    status ('A' = valid), latRef ('N'/'S'), lonRef ('E'/'W'), pad
//   float32le lat (NMEA DDMM.mmmm), lon (DDDMM.mmmm), speed (knots), heading
//
// Rather than hard-coding one offset, we locate the "A[NS][EW]" marker and
// read relative to it. Encrypted variants (e.g. some Viofo A129 firmware)
// won't match and will be skipped.

const { nmeaCoord } = require('./nmea');

const MARKER = Buffer.from('freeGPS ', 'latin1');
const SEARCH_LIMIT = 160; // how far into the box to look for the status marker

/**
 * Parse a single freeGPS box. `buf` should start at the box's 4-byte size
 * field (i.e. 4 bytes before "freeGPS ") and contain at least ~200 bytes.
 */
function parseFreeGpsBox(buf) {
  const limit = Math.min(buf.length - 16, SEARCH_LIMIT);
  for (let i = 12 + 24; i < limit; i++) {
    if (buf[i] !== 0x41 /* A */) continue;
    const ns = buf[i + 1], ew = buf[i + 2];
    if ((ns !== 0x4e && ns !== 0x53) || (ew !== 0x45 && ew !== 0x57)) continue;

    const t = i - 24;
    const [hour, min, sec, year, month, day] = [0, 1, 2, 3, 4, 5].map((k) => buf.readInt32LE(t + k * 4));
    const f = i + 4;
    const rawLat = buf.readFloatLE(f);
    const rawLon = buf.readFloatLE(f + 4);
    const knots = buf.readFloatLE(f + 8);
    const heading = buf.readFloatLE(f + 12);

    const lat = nmeaCoord(String(rawLat), String.fromCharCode(ns));
    const lon = nmeaCoord(String(rawLon), String.fromCharCode(ew));
    if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    if (lat === 0 && lon === 0) continue;

    let timestamp = null;
    const validTime = hour >= 0 && hour < 24 && min >= 0 && min < 60 && sec >= 0 && sec < 61 &&
      month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 0 && year < 200;
    if (validTime) timestamp = Date.UTC(2000 + year, month - 1, day, hour, min, sec);

    return {
      lat,
      lon,
      speed: Number.isFinite(knots) && knots >= 0 && knots < 1000 ? knots * 1.852 : null,
      heading: Number.isFinite(heading) && heading >= 0 && heading <= 360 ? heading : null,
      timestamp,
    };
  }
  return null;
}

module.exports = { MARKER, parseFreeGpsBox };
