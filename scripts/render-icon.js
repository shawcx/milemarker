'use strict';

// Renders build/icon.svg to build/icon.png (1024×1024) with Electron's own Chromium, so no
// image tooling is needed. electron-builder derives .ico / .icns from the PNG.
//   npx electron scripts/render-icon.js

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZE = 1024;
const svg = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.svg'), 'utf8');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE, height: SIZE, show: false, transparent: true, frame: false,
    webPreferences: { offscreen: true, zoomFactor: 1 },
  });
  const html = `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${SIZE}" height="${SIZE}" `)}</body></html>`;
  // Offscreen rendering hands us each painted frame; keep the latest.
  let frame = null;
  win.webContents.on('paint', (_e, _dirty, image) => { frame = image; });
  win.webContents.setFrameRate(10);
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  for (let i = 0; i < 50 && !frame; i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 300)); // let fonts settle, take a later frame
  let img = frame;
  if (!img) throw new Error('no frame rendered');
  if (img.getSize().width !== SIZE) img = img.resize({ width: SIZE, height: SIZE, quality: 'best' });
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), img.toPNG());
  console.log('wrote build/icon.png', img.getSize());
  app.quit();
});
