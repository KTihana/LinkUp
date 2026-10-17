// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const withPatchedCrypto = require('../plugins/withPatchedCrypto.cjs');
const begin = '// LinkUp source-built patched OpenSSL';
const end = '// End LinkUp source-built patched OpenSSL';

// Exercise the real Expo mod callback without a filesystem provider or CNG
// writes. This also catches incompatible plugin registration/API changes.
async function transform(contents, language = 'groovy') {
  const config = withPatchedCrypto({ name: 'Plugin test', slug: 'plugin-test' });
  const result = await config.mods.android.projectBuildGradle({
    ...config,
    modRequest: { platformName: 'android', modName: 'projectBuildGradle' },
    modResults: { language, contents },
  });
  return result.modResults.contents;
}

test('patched crypto resolves the exact security release exclusively from the local source build', async () => {
  const result = await transform('// Existing project settings');
  const managed = result.slice(result.indexOf(begin), result.indexOf(end));
  assert.match(managed, /exclusiveContent\s*\{\s*forRepository\s*\{\s*maven\s*\{\s*url = uri\("\$rootDir\/\.\.\/\.native-deps\/openssl\/maven"\)/);
  assert.match(managed, /filter\s*\{\s*includeGroup 'org\.linkup\.security'\s*\}/);
  assert.match(managed, /configurations\.configureEach\s*\{\s*resolutionStrategy\.dependencySubstitution\s*\{/);
  assert.match(managed, /substitute module\('io\.github\.ronickg:openssl-static'\) using module\('org\.linkup\.security:openssl-static:3\.6\.5-1'\)/);
  assert.doesNotMatch(managed, /https?:\/\/|mavenCentral\(|mavenLocal\(|flatDir\s*\{/);
  assert.equal((managed.match(/using module\(/g) ?? []).length, 1);
});

test('patched crypto preserves unrelated project settings and replaces its managed block idempotently', async () => {
  const prefix = '// Keep these settings\nallprojects { repositories { google(); mavenCentral() } }\n';
  const suffix = '\n// Keep later configuration\nrootProject.name = "LinkUp"\n';
  const result = await transform(prefix);
  assert.ok(result.startsWith(prefix));
  assert.equal(await transform(result), result);
  assert.equal((result.match(/\/\/ LinkUp source-built patched OpenSSL/g) ?? []).length, 1);

  const replaced = await transform(`${prefix}${begin}\n// obsolete managed dependency\n${end}${suffix}`);
  assert.ok(replaced.startsWith(prefix));
  assert.ok(replaced.endsWith(suffix));
  assert.ok(!replaced.includes('obsolete managed dependency'));
  assert.match(replaced, /openssl-static:3\.6\.5-1/);
  assert.equal(await transform(replaced), replaced);
});

test('patched crypto rejects unsupported languages and incomplete or reversed managed markers', async () => {
  for (const language of ['kotlin', 'kts', 'java', undefined]) {
    // Explicitly bypass the default argument for the undefined-language case.
    if (language === undefined) {
      const config = withPatchedCrypto({ name: 'Plugin test', slug: 'plugin-test' });
      await assert.rejects(config.mods.android.projectBuildGradle({ ...config, modRequest: {}, modResults: { contents: '' } }), /Groovy Android template/);
    } else await assert.rejects(transform('', language), /Groovy Android template/);
  }
  for (const contents of [begin, end, `${end}\n${begin}`]) {
    await assert.rejects(transform(contents), /Incomplete patched OpenSSL dependency block/);
  }
});
