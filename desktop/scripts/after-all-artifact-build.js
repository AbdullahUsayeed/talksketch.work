'use strict';
/** electron-builder afterAllArtifactBuild: sign the installers themselves. */
const { signFile, isSigningConfigured } = require('./sign-tool');

module.exports = async function afterAllArtifactBuild(buildResult) {
  if (!isSigningConfigured()) return [];

  const artifacts = (buildResult.artifactPaths || []).filter(
    (file) => file.toLowerCase().endsWith('.exe'),
  );
  for (const file of artifacts) signFile(file);
  return [];
};
