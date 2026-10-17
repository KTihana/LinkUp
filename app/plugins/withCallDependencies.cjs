// SPDX-License-Identifier: GPL-3.0-only
const { withProjectBuildGradle } = require('expo/config-plugins');
const start = '// Tiho pinned WebRTC dependency';
const finish = '// End Tiho pinned WebRTC dependency';
module.exports = function withCallDependencies(config) {
  return withProjectBuildGradle(config, result => {
    if (result.modResults.language !== 'groovy') throw new Error('Tiho expects the Expo Groovy Android template.');
    const block = `${start}\nallprojects {\n    configurations.configureEach {\n        resolutionStrategy.force 'org.jitsi:webrtc:155.0.0'\n    }\n}\n${finish}`;
    const old = result.modResults.contents;
    const from = old.indexOf(start), to = old.indexOf(finish);
    if ((from < 0) !== (to < 0) || (from >= 0 && to < from)) throw new Error('Incomplete Tiho WebRTC dependency block.');
    result.modResults.contents = from < 0 ? `${old}\n${block}\n` : old.slice(0, from) + block + old.slice(to + finish.length);
    return result;
  });
};
