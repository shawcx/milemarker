'use strict';

// Builders for synthetic GPS data, used by tests and scripts/make-sample.js.

function toNmea(deg, isLat) {
  const a = Math.abs(deg);
  const d = Math.floor(a);
  return { value: d * 100 + (a - d) * 60, hemi: isLat ? (deg < 0 ? 'S' : 'N') : (deg < 0 ? 'W' : 'E') };
}

/** One Novatek-style freeGPS 'free' box (type-1 layout). */
function freeGpsBox({ lat, lon, kmh = 0, heading = 0, date }) {
  const buf = Buffer.alloc(0x80);
  buf.writeUInt32BE(buf.length, 0);
  buf.write('freeGPS ', 4, 'latin1');
  buf.writeUInt32LE(0x4c, 12);
  const la = toNmea(lat, true), lo = toNmea(lon, false);
  [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(),
    date.getUTCFullYear() - 2000, date.getUTCMonth() + 1, date.getUTCDate()]
    .forEach((v, i) => buf.writeInt32LE(v, 0x10 + i * 4));
  buf.write(`A${la.hemi}${lo.hemi}`, 0x28, 'latin1');
  buf.writeFloatLE(la.value, 0x2c);
  buf.writeFloatLE(lo.value, 0x30);
  buf.writeFloatLE(kmh / 1.852, 0x34);
  buf.writeFloatLE(heading, 0x38);
  return buf;
}

/** A freeGPS record written while the receiver has no fix (status 'V', no position). */
function voidFreeGpsBox() {
  const buf = Buffer.alloc(0x80);
  buf.writeUInt32BE(buf.length, 0);
  buf.write('freeGPS ', 4, 'latin1');
  buf.writeUInt32LE(0x4c, 12);
  [23, 59, 55, 80, 1, 5].forEach((v, i) => buf.writeInt32LE(v, 0x30 + i * 4)); // RTC placeholder date
  buf.write('V00', 0x48, 'latin1');
  return buf;
}

function rmcSentence({ lat, lon, kmh = 0, heading = 0, date }) {
  const la = toNmea(lat, true), lo = toNmea(lon, false);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const time = `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}.00`;
  const d = `${pad(date.getUTCDate())}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCFullYear() % 100)}`;
  const body = `GPRMC,${time},A,${la.value.toFixed(4).padStart(9, '0')},${la.hemi},` +
    `${lo.value.toFixed(4).padStart(10, '0')},${lo.hemi},${(kmh / 1.852).toFixed(1)},${heading.toFixed(1)},${d},,,A`;
  let sum = 0;
  for (const c of body) sum ^= c.charCodeAt(0);
  return `$${body}*${sum.toString(16).toUpperCase().padStart(2, '0')}`;
}

/** A short drive: `n` fixes at 1 Hz heading roughly north-east, starting `from` seconds in. */
function drive(n = 30, start = { lat: 51.5007, lon: -0.1246 }, from = 0) {
  const t0 = Date.UTC(2026, 8, 24, 12, 0, 0);
  return Array.from({ length: n }, (_, k) => k + from).map((i) => ({
    lat: start.lat + i * 0.00012,
    lon: start.lon + i * 0.00008 + Math.sin(i / 5) * 0.0001,
    kmh: 20 + (i % 10) * 4,
    heading: 30,
    date: new Date(t0 + i * 1000),
  }));
}

module.exports = { freeGpsBox, voidFreeGpsBox, rmcSentence, drive };
