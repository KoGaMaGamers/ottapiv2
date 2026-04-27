/**
 * Deterministic per-title gradient + accent palette.
 *
 * Lifted verbatim from `tv_app_v2/src/pages/HomePage.jsx`. Used by the
 * hero carousel and any other surface that needs a stable per-title
 * background colour without persisting gradient data on the server.
 *
 * Same title → same colours, every time, even after a reload.
 */

const PALETTES: ReadonlyArray<readonly [string, string, string]> = [
  ["#0d0d1a", "#1a1a4e", "#e50914"],
  ["#0a0a0a", "#1a3a5c", "#4a9edd"],
  ["#1a0a00", "#4a1a00", "#e8720c"],
  ["#0a1a00", "#1a4a00", "#4caf50"],
  ["#1a001a", "#4a004a", "#9c27b0"],
  ["#001a1a", "#004a4a", "#009688"],
  ["#1a1a00", "#4a4a00", "#cddc39"],
  ["#0a001a", "#1a0050", "#7c4dff"],
  ["#1a0010", "#4a0030", "#f50057"],
  ["#001a10", "#004a30", "#00bfa5"],
  ["#1a1000", "#503000", "#ff8f00"],
  ["#000a1a", "#001a50", "#2979ff"],
];

function strHash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

function getPalette(title: string): readonly [string, string, string] {
  return PALETTES[strHash(title) % PALETTES.length];
}

export function getGradient(title: string): string {
  const [a, b, c] = getPalette(title);
  return `linear-gradient(145deg, ${a} 0%, ${b} 55%, ${c}33 100%)`;
}

export function getAccent(title: string): string {
  return getPalette(title)[2];
}
