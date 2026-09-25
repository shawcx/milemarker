'use strict';

// electron-builder beforePack hook: make sure the target's ffmpeg/ffprobe are downloaded so
// `extraResources` (package.json → build) can copy .cache/ffmpeg/${platform}-${arch} into the app.

const { fetchFfmpeg } = require('./fetch-ffmpeg');

// electron-builder's Arch enum → Node arch names.
const ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

module.exports = async function beforePack(context) {
  const platform = context.electronPlatformName; // darwin | win32 | linux
  const arch = ARCH[context.arch] ?? context.arch;
  console.log(`  • fetching ffmpeg for ${platform}-${arch}`);
  await fetchFfmpeg(platform, arch, (msg) => console.log(msg));
};
