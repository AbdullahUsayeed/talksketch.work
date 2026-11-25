'use strict';
/** electron-builder afterPack: sign the app executable before it is packed into NSIS. */
const path = require('node:path');
const { signFile, isSigningConfigured } = require('./sign-tool');

module.exports = async function afterPack(context) {
  if (!isSigningConfigured()) {
    console.log('[sign] no certificate configured - building unsigned');
    return;
  }
  const exe = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.exe`,
  );
  signFile(exe);
};
