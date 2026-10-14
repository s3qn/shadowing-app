const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// The Rive cat (assets/rive/kageneko.riv) is loaded through require().
config.resolver.assetExts.push('riv');

module.exports = config;
