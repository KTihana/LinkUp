// SPDX-License-Identifier: GPL-3.0-only
const { withProjectBuildGradle } = require('expo/config-plugins');
const begin = '// LinkUp source-built patched OpenSSL';
const end = '// End LinkUp source-built patched OpenSSL';
module.exports = function withPatchedCrypto(config) {
  return withProjectBuildGradle(config, result => {
    if (result.modResults.language !== 'groovy') throw new Error('LinkUp expects the Expo Groovy Android template.');
    const block = `${begin}
allprojects {
    repositories {
        exclusiveContent {
            forRepository { maven { url = uri("$rootDir/../.native-deps/openssl/maven") } }
            filter { includeGroup 'org.linkup.security' }
        }
    }
    configurations.configureEach {
        resolutionStrategy.dependencySubstitution {
            substitute module('io.github.ronickg:openssl-static') using module('org.linkup.security:openssl-static:3.6.5-1') because 'Rebuild OpenSSL security fixes from pinned official sources'
        }
    }
}
${end}`;
    const old = result.modResults.contents;
    const from = old.indexOf(begin), to = old.indexOf(end);
    if ((from < 0) !== (to < 0) || (from >= 0 && to < from)) throw new Error('Incomplete patched OpenSSL dependency block.');
    result.modResults.contents = from < 0 ? `${old}\n${block}\n` : old.slice(0, from) + block + old.slice(to + end.length);
    return result;
  });
};
