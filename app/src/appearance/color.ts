export const isHex = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
export function hsvToHex(h: number, s: number, v: number) {
  const f = (n: number) => { const k = (n + h / 60) % 6; return Math.round(255 * v * (1 - s * Math.max(0, Math.min(k, 4 - k, 1)))).toString(16).padStart(2, '0'); };
  return `#${f(5)}${f(3)}${f(1)}`.toUpperCase();
}
export function hexToHsv(hex: string) {
  const [r, g, b] = hex.slice(1).match(/../g)!.map(n => parseInt(n, 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s: max === 0 ? 0 : d / max, v: max };
}
function luminance(hex: string) {
  const c = hex.slice(1).match(/../g)!.map(n => parseInt(n, 16) / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
  return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
}
export function contrast(a: string, b: string) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
export function readableColor(hex: string, backgrounds: string[], dark: boolean) {
  if (backgrounds.every(bg => contrast(hex, bg) >= 4.5)) return hex;
  const components = hex.slice(1).match(/../g)!.map(n => parseInt(n, 16));
  for (let step = 1; step <= 100; step++) {
    const adjusted = '#' + components.map(c => Math.round(c + ((dark ? 255 : 0) - c) * step / 100).toString(16).padStart(2, '0')).join('');
    if (backgrounds.every(bg => contrast(adjusted, bg) >= 4.5)) return adjusted;
  }
  return dark ? '#FFFFFF' : '#000000';
}
