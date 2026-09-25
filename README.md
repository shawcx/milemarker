# Milemarker

Dashcam footage is mostly uneventful; you pull the SD card when something happens. Milemarker shows the
whole trip on an OpenStreetMap map, with speed and audio alongside the video, so you can see the drive at a
glance and jump straight to the incident, then export just that clip.

Built with Electron and Leaflet.

```sh
npm install
npm start                      # or: npm start -- /path/to/video1.mp4 [video2.mp4 ...]
npm test
node scripts/make-sample.js    # writes samples/synthetic.mp4 with fake embedded GPS + audio
node scripts/make-sample.js 20 --trip 3   # samples/trip/TRIP_0001..3.mp4: one drive split over 3 files
```

## Building installers

Packaging uses [electron-builder](https://www.electron.build); output goes to `dist/`.

| Command | Produces | Build on |
|---|---|---|
| `npm run dist:linux` | `Milemarker-<ver>-linux-x86_64.AppImage` and `.deb` | Linux |
| `npm run dist:win` | `…-setup-x64.exe` (installer) and `…-portable-x64.exe` | Windows, or Linux via `./scripts/dist-win-docker.sh` |
| `npm run dist:mac` | `.dmg` and `.zip`, Apple Silicon and Intel | macOS only |
| `npm run dist` | whatever the current OS builds | |

- **ffmpeg/ffprobe**: the npm packages only fetch binaries for the machine you're on, so packaging
  downloads the *target's* binaries (`scripts/fetch-ffmpeg.js`, cached in `.cache/ffmpeg/`) and ships
  them in the app's `resources/ffmpeg/` along with their licence. `src/clip.js` prefers those.
- **Windows on Linux** needs Wine for the NSIS installer; `scripts/dist-win-docker.sh` runs the build in
  electron-builder's Wine image (`electronuserland/builder:wine`, ~6 GB) instead of installing Wine.
- **macOS** must be built on a Mac (DMG tooling and code signing are macOS-only). Builds are ad-hoc
  signed, which Apple Silicon requires; without an Apple Developer ID they aren't notarized, so on first
  launch use right-click → Open (or `xattr -dr com.apple.quarantine /Applications/Milemarker.app`).
- **All three at once**: `.github/workflows/build.yml` builds on GitHub's Linux, Windows and macOS runners
  (run it from the Actions tab or push a `v*` tag) and attaches the installers to the run.
- Nothing is code-signed with a real certificate, so Windows SmartScreen and macOS Gatekeeper will warn.
- The icon is `build/icon.svg`; `npm run icon` re-renders `build/icon.png`, from which the `.ico`/`.icns`
  are generated.

## Features
- **Trips**: open (or drop) several videos at once; they're ordered by filename (dashcams name files by
  start time) and play back to back. The map shows the whole trip; ◀ / ▶ and the list switch videos, and
  clicking anywhere on the trip's track opens the right video at that spot. Speed graph, waveform and
  clip export work on the current video.
- **Incident finder**: hard braking (≥ 0.3 g over 1–3 s; "hard stop" if it ends near standstill, severe at
  ≥ 0.45 g) and swerves (≥ 0.4 g lateral above 25 km/h) are detected from the GPS speed/heading
  (`src/gps/events.js`). They're marked on the map and speed graph; ◀ / ▶ in the events bar (or `N` / `P`)
  step through them across the whole trip, starting 5 s early with the clip range preset around the event.
  Videos opened from a camera's locked folder (`RO`, `Event`, `EMR`, …) are badged "Locked by camera".
  Note: ~1 Hz GPS shows braking/swerving, not the impact itself; the tested cameras don't store G-sensor data.
- **GPS cache**: after scanning a video, its GPS is saved next to it as `<video name>.gpx`, so opening it
  again skips the scan (a 1.8 GB file: ~1.3 s → ~0.1 s). The cache keeps each fix's video time and the
  no-fix count. It's ignored and rewritten if the video is newer than it; a GPX you put there yourself
  (without our `mm:source` tag) is always used as is.
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
- Exported clips' GPX sidecars carry each point's video time (`<mm:videoTime>` element), so a clip
  starting before the first fix or across a dropout reopens in sync. For a new camera format,
add a parser and a step in `loadTrackForVideo()`.

## Notes
- Deferred feature plans live in `docs/plans/` (e.g. burning the gauge into exports).
- The ffmpeg packages download/prepare their binaries in npm install scripts, which are approved in
  `package.json` → `allowScripts`. Approvals are per version and per platform package, so after upgrading
  or installing on another OS/arch, run `npm install-scripts ls` and approve the new entries.

## License

MIT, see [LICENSE](LICENSE). Packaged builds include ffmpeg and ffprobe as separate programs; those are
GPL-licensed builds from [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static), and their licence
ships alongside them in `resources/ffmpeg/`. Map data © OpenStreetMap contributors (ODbL).
