/**
 * Keyboard / D-pad key category constants. Ported verbatim from
 * `tv_app_v2/src/utils/navigationKeys.js`. Type-narrowing helpers added
 * because the rest of the codebase will switch on these.
 */

export const BACK_KEYS = ["Escape", "Backspace", "BrowserBack"] as const;
export const DIRECTIONAL_KEYS = [
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
] as const;
export const SELECT_KEYS = ["Enter", " "] as const;
export const NAVIGATION_KEYS = [
  ...DIRECTIONAL_KEYS,
  ...SELECT_KEYS,
  ...BACK_KEYS,
] as const;

export type BackKey = (typeof BACK_KEYS)[number];
export type DirectionalKey = (typeof DIRECTIONAL_KEYS)[number];
export type SelectKey = (typeof SELECT_KEYS)[number];
export type NavigationKey = (typeof NAVIGATION_KEYS)[number];

const backKeySet = new Set<string>(BACK_KEYS);
const directionalKeySet = new Set<string>(DIRECTIONAL_KEYS);
const selectKeySet = new Set<string>(SELECT_KEYS);
const allKeySet = new Set<string>(NAVIGATION_KEYS);

export const isBackKey = (key: string): key is BackKey => backKeySet.has(key);
export const isDirectionalKey = (key: string): key is DirectionalKey =>
  directionalKeySet.has(key);
export const isSelectKey = (key: string): key is SelectKey =>
  selectKeySet.has(key);
export const isNavigationKey = (key: string): key is NavigationKey =>
  allKeySet.has(key);
