import test from 'node:test';
import assert from 'node:assert/strict';
import { activeTheme, colorFields, copyPreferences, createDefaultPreferences, formatTime, migratePreferences, palette, parseTime, patchPreferences, themeNames, themePresets, validPreferences } from '../src/appearance/palette.ts';
import { watchThemeClock } from '../src/appearance/themeClock.ts';
import { contrast } from '../src/appearance/color.ts';

const dateAt = (hour, minute = 0) => new Date(2026, 9, 15, hour, minute);

test('each color in each mode is independently selectable without transforming the chosen value', () => {
  const role = { textColor: 'ink', accentColor: 'brand', backgroundColor: 'paper', buttonColor: 'button', secondaryTextColor: 'sub', onAccentColor: 'onBrand', avatarTextColor: 'avatarText', surfaceColor: 'soft', secondarySurfaceColor: 'secondary', incomingColor: 'incoming', outgoingColor: 'outgoing', borderColor: 'line', outerColor: 'outer', tabColor: 'tabBackground', errorColor: 'error' };
  for (const theme of themeNames) for (const { field } of colorFields) for (const color of ['#FFFFFF', '#000000', '#123456', '#B9D4A0']) {
    const before = createDefaultPreferences(), snapshot = copyPreferences(before);
    const after = patchPreferences(before, { palettes: { [theme]: { [field]: color } } });
    assert.equal(palette(after, theme)[role[field]], color);
    assert.deepEqual(before, snapshot, 'the saved/draft input must not be mutated');
    const other = theme === 'Light' ? 'Dark' : 'Light';
    assert.deepEqual(after.palettes[other], before.palettes[other]);
    for (const { field: otherField } of colorFields) if (otherField !== field) assert.equal(after.palettes[theme][otherField], before.palettes[theme][otherField]);
  }
});

test('existing palettes inherit their accent for buttons and custom button colors remain independent', () => {
  const existing = patchPreferences(createDefaultPreferences(), { palettes: { Dark: { accentColor: '#CC50D8', backgroundColor: '#1B0D20', incomingColor: '#301832', outgoingColor: '#490D53' } } });
  assert.equal(validPreferences(existing), true, 'saved palettes without buttonColor remain valid');
  assert.equal(palette(migratePreferences(existing), 'Dark').button, '#CC50D8');
  const saved = copyPreferences(existing);
  const customized = patchPreferences(existing, { palettes: { Dark: { buttonColor: '#63356D' } } });
  assert.equal(palette(customized, 'Dark').button, '#63356D');
  assert.equal(palette(customized, 'Dark').brand, '#CC50D8');
  assert.deepEqual(customized.palettes.Light, existing.palettes.Light);
  assert.deepEqual(existing, saved);
  assert.equal(palette(patchPreferences(customized, { palettes: { Dark: { accentColor: '#DD00AA' } } }), 'Dark').button, '#63356D');
  assert.equal(palette(patchPreferences(customized, { palettes: { Dark: { buttonColor: undefined } } }), 'Dark').button, '#CC50D8');
});

test('button labels remain readable on pale, dark and saturated button fills', () => {
  for (const theme of themeNames) for (const buttonColor of ['#FFFFFF', '#000000', '#FFFF00', '#CC50D8', '#63356D', '#123456']) {
    const colors = palette(patchPreferences(createDefaultPreferences(), { palettes: { [theme]: { buttonColor } } }), theme);
    assert.equal(colors.button, buttonColor);
    assert.ok(contrast(colors.onButton, colors.button) >= 4.5);
  }
  assert.throws(() => patchPreferences(createDefaultPreferences(), { palettes: { Dark: { buttonColor: 'bad' } } }));
});

test('changing modes and schedules never changes either palette', () => {
  const custom = patchPreferences(createDefaultPreferences(), { palettes: { Light: { textColor: '#442244', backgroundColor: '#E8DDF0' }, Dark: { textColor: '#FEDCBA', backgroundColor: '#302010' } } });
  for (const theme of ['Dark', 'Automatic', 'Light']) {
    const next = patchPreferences(custom, { theme, schedule: { lightStart: 480, darkStart: 1200 } });
    assert.deepEqual(next.palettes, custom.palettes);
  }
});

test('old flat and named preferences migrate into their original mode only', () => {
  for (const theme of themeNames) {
    const old = { theme, textColor: '#AB1234', accentColor: '#FFFFFF', backgroundColor: '#123456' };
    const next = migratePreferences(old), other = theme === 'Light' ? 'Dark' : 'Light';
    assert.equal(next.theme, theme);
    for (const field of ['textColor', 'accentColor', 'backgroundColor']) assert.equal(next.palettes[theme][field], old[field]);
    assert.deepEqual(next.palettes[other], themePresets[other]);
    assert.equal(validPreferences(next), true);
    assert.equal(migratePreferences({ theme, textColor: '#123456', accentColor: '#ABCDEF' }).palettes[theme].backgroundColor, themePresets[theme].backgroundColor);
  }
  const named = migratePreferences({ theme: 'Dark', accent: 'Forest', text: 'Default' });
  assert.equal(named.palettes.Dark.accentColor, '#93DDB9');
  assert.deepEqual(named.palettes.Light, themePresets.Light);
  assert.equal(migratePreferences({ theme: 'Rose', accent: 'Ocean', text: 'Navy' }).theme, 'Light');
});

test('malformed colors, modes, nested patches and schedules are rejected', () => {
  const current = createDefaultPreferences(), saved = copyPreferences(current);
  for (const patch of [null, [], { theme: 'Rose' }, { accentColor: '#FFFFFF' }, { palettes: null }, { palettes: { Rose: {} } }, { palettes: { Light: { unknown: '#123456' } } }, { palettes: { Dark: { textColor: 'url(secret)' } } }, { palettes: { Light: { backgroundColor: null } } }, { schedule: { lightStart: -1 } }, { schedule: { darkStart: 1440 } }, { schedule: { lightStart: 1.5 } }, { schedule: { lightStart: 1140 } }, { schedule: { extra: 123 } }]) assert.throws(() => patchPreferences(current, patch));
  for (const value of [{ ...current, palettes: { Light: current.palettes.Light } }, { ...current, schedule: { lightStart: 0, darkStart: 0 } }, { ...current, theme: 'System' }]) assert.equal(validPreferences(value), false);
  assert.deepEqual(current, saved);
});

test('automatic switching uses local time at both exact boundaries and across midnight', () => {
  const p = patchPreferences(createDefaultPreferences(), { theme: 'Automatic' });
  for (const [hour, minute, expected] of [[0, 0, 'Dark'], [6, 59, 'Dark'], [7, 0, 'Light'], [18, 59, 'Light'], [19, 0, 'Dark'], [23, 59, 'Dark']]) assert.equal(activeTheme(p, dateAt(hour, minute)), expected);
  const overnight = patchPreferences(p, { schedule: { lightStart: 1200, darkStart: 360 } });
  for (const [hour, minute, expected] of [[19, 59, 'Dark'], [20, 0, 'Light'], [0, 0, 'Light'], [5, 59, 'Light'], [6, 0, 'Dark']]) assert.equal(activeTheme(overnight, dateAt(hour, minute)), expected);
  for (const theme of themeNames) for (const hour of [0, 8, 20]) assert.equal(activeTheme({ ...p, theme }, dateAt(hour)), theme);
  assert.equal(palette(p, activeTheme(p, dateAt(19))).paper, p.palettes.Dark.backgroundColor);
});

test('24-hour schedule inputs round-trip and reject invalid or ambiguous times', () => {
  for (const minute of [0, 1, 59, 60, 420, 1140, 1439]) assert.equal(parseTime(formatTime(minute)), minute);
  for (const time of ['', '7:00', '24:00', '12:60', '09:0', '09:00AM', '-1:00']) assert.equal(parseTime(time), null);
});

test('clock updates on the next minute, catches up after resume, and releases timers/listeners', () => {
  let now = new Date(2026, 9, 15, 18, 59, 50), resume, timer, delay, removed = false;
  const times = [], clock = {
    now: () => now,
    setTimer: (callback, milliseconds) => { timer = callback; delay = milliseconds; return callback; },
    clearTimer: () => { timer = undefined; },
    onResume: callback => { resume = callback; return () => { removed = true; }; },
  };
  const stop = watchThemeClock(time => times.push(time), clock);
  assert.equal(delay, 10000);
  now = dateAt(19); timer();
  assert.equal(times.at(-1).getHours(), 19);
  assert.equal(delay, 60000);
  now = dateAt(8); resume();
  assert.equal(times.at(-1).getHours(), 8);
  const stale = timer, count = times.length;
  stop(); stale(); resume();
  assert.equal(times.length, count);
  assert.equal(timer, undefined);
  assert.equal(removed, true);
});
