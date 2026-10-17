import { contrast, isHex } from './color.ts';

export const themeNames = ['Light', 'Dark'] as const;
export const modeNames = ['Light', 'Dark', 'Automatic'] as const;
export type Theme = typeof themeNames[number];
export type ThemeColors = {
  textColor: string; accentColor: string; backgroundColor: string;
  buttonColor?: string;
  secondaryTextColor: string; onAccentColor: string; avatarTextColor: string;
  surfaceColor: string; secondarySurfaceColor: string;
  incomingColor: string; outgoingColor: string;
  borderColor: string; outerColor: string; tabColor: string; errorColor: string;
};
export type ThemeSchedule = { lightStart: number; darkStart: number };
export type Preferences = { theme: typeof modeNames[number]; palettes: Record<Theme, ThemeColors>; schedule: ThemeSchedule };
export type AppearancePatch = {
  theme?: Preferences['theme']; palettes?: Partial<Record<Theme, Partial<ThemeColors>>>; schedule?: Partial<ThemeSchedule>;
};
export type LegacyPreferences = { theme: Theme; accentColor: string; textColor: string; backgroundColor?: string };
export const colorFields = [
  { field: 'textColor', label: 'Text color', icon: 'type' },
  { field: 'accentColor', label: 'Accent color', icon: 'sun' },
  { field: 'backgroundColor', label: 'Background color', icon: 'square' },
  { field: 'buttonColor', label: 'Buttons', icon: 'square' },
  { field: 'secondaryTextColor', label: 'Secondary text', icon: 'type' },
  { field: 'onAccentColor', label: 'Text on accent', icon: 'type' },
  { field: 'avatarTextColor', label: 'Avatar initials', icon: 'user' },
  { field: 'surfaceColor', label: 'Cards and inputs', icon: 'layers' },
  { field: 'secondarySurfaceColor', label: 'Secondary buttons', icon: 'square' },
  { field: 'incomingColor', label: 'Received bubbles', icon: 'message-circle' },
  { field: 'outgoingColor', label: 'Sent bubbles', icon: 'message-circle' },
  { field: 'borderColor', label: 'Borders and dividers', icon: 'minus' },
  { field: 'outerColor', label: 'Outer background', icon: 'maximize' },
  { field: 'tabColor', label: 'Navigation background', icon: 'layout' },
  { field: 'errorColor', label: 'Errors', icon: 'alert-circle' },
] as const;
export type ColorField = typeof colorFields[number]['field'];
const previousThemePresets: Record<Theme, ThemeColors> = {
  Light: {
    textColor: '#202A24', accentColor: '#2D5944', backgroundColor: '#FAFAF6',
    secondaryTextColor: '#707B73', onAccentColor: '#FFFFFF', avatarTextColor: '#2D5944',
    surfaceColor: '#F0F1EB', secondarySurfaceColor: '#F0F1EB', incomingColor: '#EEF0E9', outgoingColor: '#DFEBD8',
    borderColor: '#DFE4DB', outerColor: '#E6EBE4', tabColor: '#FAFAF6', errorColor: '#B83A2F',
  },
  Dark: {
    textColor: '#EDF1E9', accentColor: '#B9D4A0', backgroundColor: '#171D19',
    secondaryTextColor: '#A3B0A6', onAccentColor: '#1C2D1E', avatarTextColor: '#B9D4A0',
    surfaceColor: '#242D26', secondarySurfaceColor: '#242D26', incomingColor: '#27322A', outgoingColor: '#35482F',
    borderColor: '#37433A', outerColor: '#111613', tabColor: '#171D19', errorColor: '#ED7566',
  },
};
export const themePresets: Record<Theme, ThemeColors> = {
  Light: {
    textColor: '#182033', accentColor: '#335CFF', backgroundColor: '#FFFFFF',
    secondaryTextColor: '#737D90', onAccentColor: '#FFFFFF', avatarTextColor: '#335CFF',
    surfaceColor: '#F3F5F9', secondarySurfaceColor: '#EEF2FF', incomingColor: '#F1F3F7', outgoingColor: '#E8EEFF',
    borderColor: '#E9EDF4', outerColor: '#EEF1F7', tabColor: '#FFFFFF', errorColor: '#D33F49',
  },
  Dark: {
    textColor: '#F1F4FC', accentColor: '#A4B7FF', backgroundColor: '#101522',
    secondaryTextColor: '#939DB2', onAccentColor: '#172350', avatarTextColor: '#BCCAFF',
    surfaceColor: '#1C2333', secondarySurfaceColor: '#253252', incomingColor: '#202838', outgoingColor: '#2C3B63',
    borderColor: '#293247', outerColor: '#0B0F19', tabColor: '#101522', errorColor: '#FF8A96',
  },
};
export function createDefaultPreferences(): Preferences {
  return { theme: 'Light', palettes: { Light: { ...themePresets.Light }, Dark: { ...themePresets.Dark } }, schedule: { lightStart: 7 * 60, darkStart: 19 * 60 } };
}
export const defaults = createDefaultPreferences();
export function copyPreferences(p: Preferences): Preferences {
  return { ...p, palettes: { Light: { ...p.palettes.Light }, Dark: { ...p.palettes.Dark } }, schedule: { ...p.schedule } };
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]) { return Object.keys(value).every(key => keys.includes(key)); }
export function validSchedule(value: unknown): value is ThemeSchedule {
  if (!object(value) || !onlyKeys(value, ['lightStart', 'darkStart'])) return false;
  const { lightStart, darkStart } = value;
  return typeof lightStart === 'number' && Number.isInteger(lightStart) && lightStart >= 0 && lightStart < 1440 && typeof darkStart === 'number' && Number.isInteger(darkStart) && darkStart >= 0 && darkStart < 1440 && lightStart !== darkStart;
}
export function validPreferences(value: unknown): value is Preferences {
  if (!object(value) || !onlyKeys(value, ['theme', 'palettes', 'schedule'])) return false;
  if (!modeNames.includes(value.theme as Preferences['theme']) || !validSchedule(value.schedule) || !object(value.palettes) || !onlyKeys(value.palettes, themeNames)) return false;
  const palettes = value.palettes;
  return themeNames.every(theme => {
    const colors = palettes[theme];
    return object(colors) && onlyKeys(colors, colorFields.map(c => c.field)) && colorFields.every(({ field }) => (field === 'buttonColor' && colors[field] === undefined) || isHex(colors[field]));
  });
}
export function validLegacyPreferences(value: unknown): value is LegacyPreferences {
  return object(value) && onlyKeys(value, ['theme', 'accentColor', 'textColor', 'backgroundColor']) && themeNames.includes(value.theme as Theme) && isHex(value.accentColor) && isHex(value.textColor) && (value.backgroundColor === undefined || isHex(value.backgroundColor));
}
function tint(foreground: string, background: string, amount: number) {
  const channels = [1, 3, 5].map(i => Math.round(parseInt(foreground.slice(i, i + 2), 16) * amount + parseInt(background.slice(i, i + 2), 16) * (1 - amount)));
  return '#' + channels.map(c => c.toString(16).padStart(2, '0')).join('');
}
function migrateFlat(p: LegacyPreferences): Preferences {
  const result = createDefaultPreferences();
  const paper = p.backgroundColor ?? themePresets[p.theme].backgroundColor;
  const dark = contrast(paper, '#FFFFFF') > contrast(paper, '#000000');
  const tone = dark ? '#FFFFFF' : '#000000';
  const surface = tint(tone, paper, .06);
  result.theme = p.theme;
  // Keep the previous visible colors in their original mode only.
  result.palettes[p.theme] = {
    textColor: p.textColor, accentColor: p.accentColor, backgroundColor: paper,
    secondaryTextColor: p.textColor, onAccentColor: p.textColor, avatarTextColor: p.textColor,
    surfaceColor: surface, secondarySurfaceColor: surface, incomingColor: surface, outgoingColor: tint(p.accentColor, paper, .2),
    borderColor: tint(tone, paper, .16), outerColor: tint(dark ? '#000000' : '#FFFFFF', paper, .08), tabColor: paper, errorColor: dark ? '#ED7566' : '#B83A2F',
  };
  return result;
}
export function migratePreferences(value: unknown): Preferences | null {
  if (validPreferences(value)) {
    const next = copyPreferences(value);
    for (const theme of themeNames) {
      const previous = previousThemePresets[theme];
      // Refresh only the untouched old default. Preserve every custom palette.
      if (Object.keys(next.palettes[theme]).length === Object.keys(previous).length && Object.entries(previous).every(([field, color]) => next.palettes[theme][field as keyof ThemeColors] === color)) next.palettes[theme] = { ...themePresets[theme] };
    }
    return next;
  }
  if (validLegacyPreferences(value)) return migrateFlat(value);
  if (!object(value) || !onlyKeys(value, ['theme', 'accent', 'text'])) return null;
  const p = value as Record<string, string>, dark = p.theme === 'Dark';
  const accents: Record<string, string[]> = { Violet: ['#7160EA', '#C3B7FF'], Ocean: ['#2563CB', '#9EC5FF'], Forest: ['#176D54', '#93DDB9'], Berry: ['#AD365C', '#FFA9C8'] };
  const texts: Record<string, string[]> = { Default: ['#20212A', '#F2EFF8'], Navy: ['#233C63', '#C4D9FA'], Forest: ['#244E3B', '#C1E5CB'], Plum: ['#55395E', '#E5CEEF'] };
  if (!['Light', 'Dark', 'Rose'].includes(p.theme) || !accents[p.accent] || !texts[p.text]) return null;
  return migrateFlat({ theme: dark ? 'Dark' : 'Light', accentColor: accents[p.accent][dark ? 1 : 0], textColor: texts[p.text][dark ? 1 : 0] });
}
export function patchPreferences(current: Preferences, patch: AppearancePatch): Preferences {
  if (!object(patch) || !onlyKeys(patch, ['theme', 'palettes', 'schedule'])) throw new Error('Invalid appearance settings.');
  const next = copyPreferences(current);
  if ('theme' in patch) next.theme = patch.theme!;
  if ('palettes' in patch) {
    if (!object(patch.palettes) || !onlyKeys(patch.palettes, themeNames)) throw new Error('Invalid appearance settings.');
    for (const theme of themeNames) if (theme in patch.palettes) {
      const colors = patch.palettes[theme];
      if (!object(colors) || !onlyKeys(colors, colorFields.map(c => c.field))) throw new Error('Invalid appearance settings.');
      next.palettes[theme] = { ...next.palettes[theme], ...colors };
    }
  }
  if ('schedule' in patch) {
    if (!object(patch.schedule) || !onlyKeys(patch.schedule, ['lightStart', 'darkStart'])) throw new Error('Invalid appearance settings.');
    next.schedule = { ...next.schedule, ...patch.schedule };
  }
  if (!validPreferences(next)) throw new Error('Invalid appearance settings.');
  return next;
}
export function activeTheme(p: Preferences, now = new Date()): Theme {
  if (p.theme !== 'Automatic') return p.theme;
  const minute = now.getHours() * 60 + now.getMinutes(), { lightStart, darkStart } = p.schedule;
  const light = lightStart < darkStart ? minute >= lightStart && minute < darkStart : minute >= lightStart || minute < darkStart;
  return light ? 'Light' : 'Dark';
}
export function formatTime(minutes: number) { return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`; }
export function parseTime(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}
export function palette(p: Preferences, theme = activeTheme(p)) {
  const c = p.palettes[theme];
  // Older palettes inherit the accent so controls cannot retain a separate
  // preset green. An explicit button color stays independent of the accent.
  const button = c.buttonColor ?? c.accentColor;
  const onButton = contrast(c.textColor, button) >= 4.5 ? c.textColor : contrast('#FFFFFF', button) >= contrast('#000000', button) ? '#FFFFFF' : '#000000';
  return {
    button, onButton,
    brand: c.accentColor, avatarText: c.avatarTextColor, link: c.textColor, onBrand: c.onAccentColor,
    ink: c.textColor, sub: c.secondaryTextColor, soft: c.surfaceColor, paper: c.backgroundColor,
    secondary: c.secondarySurfaceColor, outgoing: c.outgoingColor, incoming: c.incomingColor,
    line: c.borderColor, outer: c.outerColor, tabBackground: c.tabColor, preview: c.surfaceColor,
    previewText: c.secondaryTextColor, error: c.errorColor,
    dark: contrast(c.backgroundColor, '#FFFFFF') > contrast(c.backgroundColor, '#000000'),
  };
}
export type Palette = ReturnType<typeof palette>;
