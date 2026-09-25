# Dashcam Track Viewer

Electron app that plays a dashcam video alongside its GPS track on an OpenStreetMap (Leaflet) map.

```sh
npm install
npm start                      # or: npm start -- /path/to/video1.mp4 [video2.mp4 ...]
npm test
node scripts/make-sample.js    # writes samples/synthetic.mp4 with fake embedded GPS + audio
node scripts/make-sample.js 20 --trip 3   # samples/trip/TRIP_0001..3.mp4: one drive split over 3 files
```

## Features
- **Trips**: open (or drop) several videos at once; they're ordered by filename (dashcams name files by
  start time) and play back to back. The map shows the whole trip; ◀ / ▶ and the list switch videos, and
  clicking anywhere on the trip's track opens the right video at that spot. Speed graph, waveform and
  clip export work on the current video.
- **GPS cache**: after scanning a video, its GPS is saved next to it as `<video name>.gpx`, so opening it
  again skips the scan (a 1.8 GB file: ~1.3 s → ~0.1 s). The cache keeps each fix's video time and the
  no-fix count. It's ignored and rewritten if the video is newer than it; a GPX you put there yourself
  (without our `dtv:source` tag) is always used as is.
- Open or drag-and-drop a video; the GPS track is extracted and drawn, coloured by speed.
- The marker follows video playback (interpolated, rotated to heading); click the track to seek.
- **GPS offset** shifts the track against the video when the two are slightly out of sync.
- **Speed graph** under the video: speed over time on the video's timeline. Hover for values, click to seek;
  it also shows the clip selection and the playhead.
- **Audio waveform** under the speed graph when the video has audio (decoded in the background with the
  bundled ffmpeg, `src/audio.js`). Same timeline: hover shows the level in dBFS, click seeks. Scaled to the
  file's loudest peak so quiet dashcam mics are still visible.
- **Units**: toggle km/h / mph in the details header (remembered). Data is stored in km/h; only display converts.
- GPX / NMEA files can be opened on their own, or on top of a loaded video.
- **Clip export**: set In/Out (buttons or `I` / `O` keys), then *Export clip…*. ffmpeg/ffprobe come from
  npm (`ffmpeg-static`, `@ffprobe-installer/ffprobe`); override with `FFMPEG_PATH` / `FFPROBE_PATH`.
  - *Fast* stream-copies (lossless, instant) but starts at the keyframe at or before In.
  - *Precise* re-encodes to H.264/AAC, so the clip starts on the exact frame.
  - *GPX* writes the clip's track next to it with the same name, so the clip opens here with its GPS
    (the embedded dashcam GPS data doesn't survive the cut).

## GPS sources (`src/gps/`)
Tried in order for each video:
1. **Sidecar file**: same basename with `.gpx`, `.nmea`, `.log` or `.txt`
2. **Novatek `freeGPS` boxes** embedded in MP4/MOV (Viofo and many generic dashcams): `novatek.js`
3. **Raw NMEA `$xxRMC` sentences** embedded anywhere in the file: `nmea.js`

Each parser returns `{ lat, lon, speed (km/h), heading, timestamp }` points; `finalizeTrack()` in
`index.js` ensures `t` (seconds into the video).

- **Novatek** writes one record per second of video whether or not the GPS has a fix, so a fix's record
  index is its video time. Records without a fix (status `V`, e.g. while acquiring satellites) are counted
  and reported ("32 of 600 records without GPS fix"). GPS timestamps are *not* used for timing: they drift
  against the video clock and sometimes repeat a second.
- Other sources are timed from their GPS timestamps relative to the first fix.
- Gaps longer than 3 s are shown as dropouts: dashed on the map, a break in the speed graph, and
  "no GPS fix" in the telemetry.
- Exported clips' GPX sidecars carry each point's video time (`<dtv:videoTime>` extension), so a clip
  starting before the first fix or across a dropout reopens in sync. For a new camera format,
add a parser and a step in `loadTrackForVideo()`.

## Notes
- Deferred feature plans live in `docs/plans/` (e.g. burning the gauge into exports).
- The ffmpeg packages download/prepare their binaries in npm install scripts, which are approved in
  `package.json` → `allowScripts`. Approvals are per version and per platform package, so after upgrading
  or installing on another OS/arch, run `npm install-scripts ls` and approve the new entries.
- When packaging (e.g. electron-builder), the binaries must be unpacked from the asar:
  `"asarUnpack": ["node_modules/ffmpeg-static/**", "node_modules/@ffprobe-installer/**"]`.
  `src/clip.js` already rewrites `app.asar` → `app.asar.unpacked` in the paths.
- The bundled ffmpeg builds are GPL-licensed; keep that in mind if you distribute the app.
