'use strict';

// Downloads ffmpeg + ffprobe for a target platform/arch into .cache/ffmpeg/<platform>-<arch>/,
// for packaging. The npm packages we use in development only install binaries for the
// machine running `npm install`, so a Windows build made on Linux would otherwise ship Linux
// binaries. Source: the same GitHub release ffmpeg-static uses (it carries matching ffprobe).
//
//   node scripts/fetch-ffmpeg.js [platform] [arch]     (defaults: this machine)
//
// Also used by electron-builder's beforePack hook (scripts/before-pack.js).

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const TAG = require('ffmpeg-static/package.json')['ffmpeg-static']['binary-release-tag'];
const BASE = `https://github.com/eugeneware/ffmpeg-static/releases/download/${TAG}`;
const SUPPORTED = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'];

const cacheDir = (platform, arch) => path.join(__dirname, '..', '.cache', 'ffmpeg', `${platform}-${arch}`);

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'milemarker-build' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(get(new URL(res.headers.location, url).href, redirects - 1));
      } else if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`GET ${url}: HTTP ${res.statusCode}`));
      } else {
        resolve(res);
      }
    }).on('error', reject);
  });
}

async function download(url, dest, { gunzip = false } = {}) {
  const tmp = `${dest}.part`;
  const res = await get(url);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    (gunzip ? res.pipe(zlib.createGunzip()) : res).pipe(out).on('finish', resolve).on('error', reject);
    res.on('error', reject);
  });
  fs.renameSync(tmp, dest);
}

/** Ensure binaries for platform/arch are cached; returns the directory. */
async function fetchFfmpeg(platform = process.platform, arch = process.arch, log = console.log) {
  const target = `${platform}-${arch}`;
  if (!SUPPORTED.includes(target)) throw new Error(`No ffmpeg build for ${target} (have: ${SUPPORTED.join(', ')})`);
  const dir = cacheDir(platform, arch);
  fs.mkdirSync(dir, { recursive: true });
  const exe = platform === 'win32' ? '.exe' : '';
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const dest = path.join(dir, tool + exe);
    if (fs.existsSync(dest)) continue;
    log(`  downloading ${tool} ${TAG} for ${target}…`);
    await download(`${BASE}/${tool}-${target}.gz`, dest, { gunzip: true });
    if (!exe) fs.chmodSync(dest, 0o755);
  }
  // Licence + build notes travel with the binaries (ffmpeg builds are GPL).
  for (const doc of ['LICENSE', 'README']) {
    const dest = path.join(dir, `ffmpeg-${doc}.txt`);
    if (!fs.existsSync(dest)) await download(`${BASE}/${target}.${doc}`, dest);
  }
  return dir;
}

module.exports = { fetchFfmpeg, cacheDir, SUPPORTED };

if (require.main === module) {
  const [platform, arch] = process.argv.slice(2);
  fetchFfmpeg(platform, arch).then((dir) => console.log(`ffmpeg ready in ${dir}`), (err) => {
    console.error(err.message);
    process.exit(1);
  });
}
