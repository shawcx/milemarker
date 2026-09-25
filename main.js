'use strict';

const { app, BrowserWindow, dialog, ipcMain, session } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');
const gps = require('./src/gps');
const { writeGpx } = require('./src/gps/gpx');
const { detectEvents, isLockedPath } = require('./src/gps/events');
const clip = require('./src/clip');
const audio = require('./src/audio');

const VIDEO_EXTS = ['mp4', 'mov', 'MP4', 'MOV', 'ts', 'TS', 'avi', 'AVI', 'mkv'];
const TRACK_EXTS = ['gpx', 'nmea', 'log', 'txt'];

let win;
const openedVideos = new Set(); // paths the user opened; renderer requests are checked against it
let activeExport = null;
let activeAudio = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#15171a',
    title: 'Milemarker',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Videos autoplay (with sound) when opened, including via drag-drop and the CLI.
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// OSM tile usage policy requires an identifying User-Agent.
function setupTileHeaders() {
  const ua = `Milemarker/${app.getVersion()} (Electron; +https://www.openstreetmap.org/copyright)`;
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://tile.openstreetmap.org/*'] },
    (details, cb) => {
      details.requestHeaders['User-Agent'] = ua;
      cb({ requestHeaders: details.requestHeaders });
    }
  );
}

const withEvents = (track) => Object.assign(track, { events: detectEvents(track.points) });

// Dashcam filenames start with the recording time, so name order is trip order.
const byName = (a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true });

/** Load one or more videos as a trip: [{ videoPath, videoUrl, name, track }] in trip order. */
async function loadVideos(paths) {
  const sorted = [...paths].sort(byName);
  const videos = [];
  for (const [i, videoPath] of sorted.entries()) {
    const name = path.basename(videoPath);
    const progress = (p) => win?.webContents.send('scan-progress', { index: i, count: sorted.length, name, progress: p });
    progress(0);
    const track = withEvents(await gps.loadTrackForVideo(videoPath, progress));
    openedVideos.add(videoPath);
    videos.push({ videoPath, videoUrl: pathToFileURL(videoPath).href, name, track, locked: isLockedPath(videoPath) });
  }
  return { videos };
}

ipcMain.handle('open-video', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Open dashcam video(s)',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Video', extensions: VIDEO_EXTS }, { name: 'All files', extensions: ['*'] }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return loadVideos(res.filePaths);
});

/** Load GPS files: { tracks: [{ name, track }] } in name order. */
async function loadTrackFiles(paths) {
  const sorted = [...paths].sort(byName);
  const tracks = [];
  for (const f of sorted) tracks.push({ name: path.basename(f), track: withEvents(await gps.loadTrackFile(f)) });
  return { tracks };
}

ipcMain.handle('open-track', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Open GPS track(s)',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'GPS track', extensions: TRACK_EXTS }, { name: 'All files', extensions: ['*'] }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return loadTrackFiles(res.filePaths);
});

// Drag-drop / CLI: any videos become a trip (their GPX sidecars load with them);
// otherwise all the track files are opened.
ipcMain.handle('open-paths', async (_e, filePaths) => {
  const isTrack = (f) => TRACK_EXTS.includes(path.extname(f).slice(1).toLowerCase());
  const videos = filePaths.filter((f) => !isTrack(f));
  if (videos.length) return loadVideos(videos);
  const tracks = filePaths.filter(isTrack);
  return tracks.length ? loadTrackFiles(tracks) : null;
});

function checkVideo(videoPath) {
  if (!openedVideos.has(videoPath)) throw new Error('Unknown video');
  return videoPath;
}

// ---------------------------------------------------------------- clip export

const stamp = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}m${String(Math.floor(t % 60)).padStart(2, '0')}s`;

// Step 1: ask for a destination and resolve the real start time (fast mode snaps to a keyframe).
ipcMain.handle('export-prepare', async (_e, { videoPath, start, end, mode }) => {
  const currentVideoPath = checkVideo(videoPath);
  const base = path.basename(currentVideoPath, path.extname(currentVideoPath));
  const res = await dialog.showSaveDialog(win, {
    title: 'Export clip',
    defaultPath: path.join(path.dirname(currentVideoPath), `${base}_${stamp(start)}-${stamp(end)}.mp4`),
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
  });
  if (res.canceled || !res.filePath) return null;
  if (path.resolve(res.filePath) === path.resolve(currentVideoPath)) throw new Error('Cannot overwrite the source video');
  const realStart = mode === 'fast' ? await clip.keyframeAtOrBefore(currentVideoPath, start) : start;
  return { dest: res.filePath, start: realStart, end };
});

// Step 2: write the optional GPX sidecar and run ffmpeg. `gpxPoints` have `t` in clip time.
ipcMain.handle('export-run', async (_e, { videoPath, dest, start, end, mode, gpxPoints }) => {
  const src = checkVideo(videoPath);
  const gpxPath = gpxPoints?.length > 1 ? dest.replace(/\.[^./\\]+$/, '') + '.gpx' : null;
  if (gpxPath) {
    const source = `clip of ${path.basename(src)} (${start.toFixed(1)}–${end.toFixed(1)} s)`;
    await fs.promises.writeFile(gpxPath, writeGpx(gpxPoints, { name: path.basename(dest), source }));
  }
  activeExport = clip.runExport({ src, dest, start, end, mode },
    (p) => win?.webContents.send('export-progress', p));
  try {
    await activeExport.promise;
    return { dest, gpxPath };
  } catch (err) {
    await Promise.all([dest, gpxPath].filter(Boolean).map((f) => fs.promises.rm(f, { force: true })));
    if (err.cancelled) return null;
    throw err;
  } finally {
    activeExport = null;
  }
});

ipcMain.handle('export-cancel', () => activeExport?.cancel());

// Waveform peaks for the current video (null if it has no audio or a newer request superseded it).
ipcMain.handle('audio-peaks', async (_e, videoPath) => {
  activeAudio?.cancel();
  const job = audio.audioPeaks(checkVideo(videoPath));
  activeAudio = job;
  try {
    return await job.promise;
  } catch (err) {
    if (err.cancelled) return null;
    throw err;
  } finally {
    if (activeAudio === job) activeAudio = null;
  }
});

app.whenReady().then(() => {
  setupTileHeaders();
  createWindow();
  // Allow `npm start -- /path/to/video1.mp4 [video2.mp4 ...]`
  const args = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-')).map((a) => path.resolve(a));
  if (args.length) win.webContents.once('did-finish-load', () => win.webContents.send('open-args', args));
});

app.on('window-all-closed', () => app.quit());
