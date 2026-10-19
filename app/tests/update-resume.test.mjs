// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the provider across a vault-driven remount, retaining the native
// module just as Android does while its permission activity is open.
const source = ts.transpileModule(readFileSync(new URL('../src/updates/UpdatesProvider.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
}).outputText;

async function mount(native, fetchRelease) {
  const slots = [], effects = [];
  let cursor = 0, first = true;
  const react = {
    createContext: () => ({ Provider: 'provider' }),
    createElement: (_type, props) => props.value,
    useState(initial) {
      const index = cursor++;
      if (first) slots[index] = initial;
      return [slots[index], value => { slots[index] = value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (first) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback: fn => fn,
    useEffect: fn => { if (first) effects.push(fn); },
  };
  const dependencies = {
    react,
    'react-native': { Platform: { OS: 'android' }, AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } },
    'expo-modules-core': { requireNativeModule: () => native },
    'expo-secure-store': { getItemAsync: async () => null, setItemAsync: async () => {} },
    './releaseTrust.json': { repository: 'owner/app', publicKey: 'test' },
    '../messaging/MessagingProvider': { useMessaging: () => ({ view: { policy: 'internet' }, preferencesReady: true }) },
    './release': { latestRelease: fetchRelease, migrateReleaseRepository: x => x, validRepository: () => true },
  };
  const exports = {};
  vm.runInNewContext(source, { exports, require: name => {
    assert.ok(name in dependencies, name);
    return dependencies[name];
  }, console: { info() {} }, AbortController, setTimeout, clearTimeout });
  const render = () => { cursor = 0; const value = exports.UpdatesProvider({ children: null }); first = false; return value; };
  render();
  for (const effect of effects) effect();
  await new Promise(resolve => setImmediate(resolve));
  return render;
}

test('returning after a vault lock restores installation without a new download or automatic check', async () => {
  let checks = 0, installs = 0;
  const native = {
    installed: async () => ({ version: '0.3.3', versionCode: 12, packageName: 'org.commonchat.app', updateReady: true }),
    install: async () => ++installs === 1 ? 'permission' : 'installer',
  };
  const fetchRelease = async () => { checks++; return null; };
  const before = await mount(native, fetchRelease);
  await before().install();
  assert.equal(before().status, 'permission');
  const after = await mount(native, fetchRelease);
  assert.equal(after().status, 'ready');
  await after().check();
  assert.equal(checks, 0, 'a foreground check must not overwrite the recovered Install button');
  await after().save({ repository: 'owner/app', automatic: false });
  assert.equal(after().status, 'ready');
  await after().install();
  assert.equal(after().status, 'installer');
});
