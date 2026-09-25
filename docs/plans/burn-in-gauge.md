# Plan: burn the speed gauge into exported clips

Status: **not started**. Drafted 2026-09-24; on hold until the user picks it back up.

## Goal
Clip export gains an option to re-encode with the analog speed gauge drawn onto the video,
bottom-right. The needle matches what the app shows during playback, including the GPS offset.

## Approach
Draw the gauge as a transparent PNG for each video frame, then have ffmpeg overlay the sequence
while re-encoding.

1. **Make the gauge drawable off-screen**: `renderer/gauge.js` currently relies on CSS classes in
   `styles.css`, which don't apply when the SVG is converted to an image. Build the styles into the
   SVG and accept any size. The on-screen gauge must look unchanged.
2. **Probe the source** with ffprobe for width, height and frame rate (in `src/clip.js`).
3. **Draw the frames** in the renderer: for each frame time in the clip, work out the speed with
   `sampleAt(t + offset)`, set the gauge, turn the SVG into a canvas and then a PNG, and write it to a
   temp folder via IPC. Gauge width is about 24% of the video width, the same proportion as on screen.
4. **Encode with the overlay** by adding a gauge mode to `ffmpegArgs`:
   `-framerate <fps> -i <tmp>/%06d.png`, then
   `filter_complex "[0:v][1:v]overlay=W-w-<m>:H-h-<m>:eof_action=repeat"`, then H.264 (CRF 18 veryfast)
   and AAC. The GPX sidecar is still written.
5. **UI**: a "Gauge" checkbox in the clip bar. Ticking it forces Precise mode and disables Fast, since
   overlaying requires re-encoding. Progress covers two stages (drawing frames, then encoding).
   Cancel works in both stages, and the temp folder is always cleaned up.
6. **Tests**:
   - A unit test overlays a known PNG and checks the pixels in the corner.
   - An in-app end-to-end export with the gauge, pulling frames out to check the needle matches the
     speed at those times.
   - The existing export tests still pass.
7. **README**: document the option.

## Defaults (confirm with the user before building)
- Frame rate: match the video's, capped at 30 fps. A 60 s clip means about 1,800 small temp PNGs.
- Position and size: bottom-right, about 24% of the video width, with a small margin.
- Units: follow the app's km/h / mph setting (added after this plan was drafted).
- Quality: the same as Precise mode. 4K will be slow; hardware encoding could come later.

## Alternative considered
Pipe raw RGBA frames into ffmpeg's stdin (`-f rawvideo -pix_fmt rgba -s WxH -r fps -i pipe:0`) instead
of writing temp PNGs. It avoids the temp files but is more complex and harder to debug. Start with PNGs.
