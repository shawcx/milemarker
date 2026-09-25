'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('dashcam', {
  openVideo: () => ipcRenderer.invoke('open-video'),
  openTrack: () => ipcRenderer.invoke('open-track'),
  openPaths: (paths) => ipcRenderer.invoke('open-paths', paths),
  pathForFile: (file) => webUtils.getPathForFile(file),
  exportPrepare: (opts) => ipcRenderer.invoke('export-prepare', opts),
  exportRun: (opts) => ipcRenderer.invoke('export-run', opts),
  exportCancel: () => ipcRenderer.invoke('export-cancel'),
  audioPeaks: (videoPath) => ipcRenderer.invoke('audio-peaks', videoPath),
  onExportProgress: (cb) => ipcRenderer.on('export-progress', (_e, p) => cb(p)),
  onScanProgress: (cb) => ipcRenderer.on('scan-progress', (_e, p) => cb(p)),
  onOpenArgs: (cb) => ipcRenderer.on('open-args', (_e, paths) => cb(paths)),
});
