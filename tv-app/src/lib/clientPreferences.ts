/**
 * Centralized local-first preference storage.
 *
 * Faithful port of `tv_app_v2/src/utils/clientPreferences.js`. Schema
 * is versioned (v3) so old installs migrate from the legacy split keys
 * (`ott_content_prefs` + `ott_adult_prefs`) into a single bag at
 * `ott_client_prefs_v3`.
 *
 * Storage is the single source of truth: writers persist immediately,
 * readers parse on every call. Pages that need reactivity must wrap
 * their reads in a Solid signal — this module does not own a signal.
 */

const PREFS_STORAGE_KEY = "ott_client_prefs_v3";
const LEGACY_CONTENT_KEY = "ott_content_prefs";
const LEGACY_ADULT_KEY = "ott_adult_prefs";
const SCHEMA_VERSION = 3;

export type PlaybackMode = "auto" | "web" | "native";
export type SubtitleMode = "off" | "preferred";
export type Theme = "dark" | "light";

export interface PlaybackPrefs {
  mode: PlaybackMode;
  autoplay: boolean;
  subtitleMode: SubtitleMode;
  preferredSubtitleLang: string | null;
  preferredAudioLang: string | null;
  catchupSeekStepSec: number;
}

export interface UiPrefs {
  lastTab: string;
  focusRestore: boolean;
  theme: Theme;
}

/**
 * Per-section content category filter.
 *   null  → all categories (no restriction)
 *   []    → user explicitly deselected everything
 *   [ids] → only these category IDs are visible
 */
export type CategoryFilter = null | string[];

export interface ContentPrefs {
  live: CategoryFilter;
  movies: CategoryFilter;
  series: CategoryFilter;
  adult: CategoryFilter;
}

export interface ClientPrefs {
  schemaVersion: number;
  playback: PlaybackPrefs;
  ui: UiPrefs;
  content: ContentPrefs;
}

const DEFAULT_PREFS: ClientPrefs = {
  schemaVersion: SCHEMA_VERSION,
  playback: {
    mode: "auto",
    autoplay: true,
    subtitleMode: "off",
    preferredSubtitleLang: null,
    preferredAudioLang: null,
    catchupSeekStepSec: 30,
  },
  ui: {
    lastTab: "home",
    focusRestore: true,
    theme: "dark",
  },
  content: {
    live: null,
    movies: null,
    series: null,
    adult: null,
  },
};

function safeClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

interface ClientPrefsPatch {
  schemaVersion?: number;
  playback?: Partial<PlaybackPrefs>;
  ui?: Partial<UiPrefs>;
  content?: Partial<ContentPrefs>;
}

function mergePrefs(base: ClientPrefs, patch: ClientPrefsPatch | null | undefined): ClientPrefs {
  const out = safeClone(base);
  if (!patch || typeof patch !== "object") return out;
  if (patch.playback && typeof patch.playback === "object") {
    out.playback = { ...out.playback, ...patch.playback };
  }
  if (patch.ui && typeof patch.ui === "object") {
    out.ui = { ...out.ui, ...patch.ui };
  }
  if (patch.content && typeof patch.content === "object") {
    out.content = { ...out.content, ...patch.content };
  }
  if (typeof patch.schemaVersion === "number") {
    out.schemaVersion = patch.schemaVersion;
  }
  return out;
}

function loadLegacyContentPrefs(): Partial<ContentPrefs> | null {
  try {
    const raw = localStorage.getItem(LEGACY_CONTENT_KEY);
    return raw ? (JSON.parse(raw) as Partial<ContentPrefs>) : null;
  } catch {
    return null;
  }
}

function loadLegacyAdultPrefs(): CategoryFilter | null {
  try {
    const raw = localStorage.getItem(LEGACY_ADULT_KEY);
    return raw ? (JSON.parse(raw) as CategoryFilter) : null;
  } catch {
    return null;
  }
}

function migrateToV3(value: unknown): ClientPrefs {
  const seed = mergePrefs(DEFAULT_PREFS, (value as ClientPrefsPatch) ?? null);
  if (!seed.content || typeof seed.content !== "object") {
    seed.content = safeClone(DEFAULT_PREFS.content);
  }

  if (
    seed.content.live === undefined ||
    seed.content.movies === undefined ||
    seed.content.series === undefined
  ) {
    const legacyContent = loadLegacyContentPrefs();
    if (legacyContent && typeof legacyContent === "object") {
      seed.content.live = legacyContent.live ?? null;
      seed.content.movies = legacyContent.movies ?? null;
      seed.content.series = legacyContent.series ?? null;
    }
  }

  if (seed.content.adult === undefined) {
    seed.content.adult = loadLegacyAdultPrefs();
  }

  seed.schemaVersion = SCHEMA_VERSION;
  return seed;
}

export function getClientPreferences(): ClientPrefs {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) {
      const migrated = migrateToV3({});
      localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(migrated));
      return migrated;
    }

    const parsed = JSON.parse(raw) as Partial<ClientPrefs>;
    if (
      !parsed?.schemaVersion ||
      parsed.schemaVersion < SCHEMA_VERSION
    ) {
      const migrated = migrateToV3(parsed);
      localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(migrated));
      return migrated;
    }
    return mergePrefs(DEFAULT_PREFS, parsed as ClientPrefsPatch);
  } catch {
    const fallback = safeClone(DEFAULT_PREFS);
    try {
      localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(fallback));
    } catch {
      /* localStorage unavailable — fall through */
    }
    return fallback;
  }
}

export function setClientPreferences(nextValue: ClientPrefsPatch): ClientPrefs {
  const current = getClientPreferences();
  const merged = mergePrefs(current, nextValue);
  merged.schemaVersion = SCHEMA_VERSION;
  try {
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(merged));
  } catch {
    /* ignore */
  }
  return merged;
}

export interface ContentPrefsView {
  live: CategoryFilter;
  movies: CategoryFilter;
  series: CategoryFilter;
}

export function getContentPreferences(): ContentPrefsView {
  const prefs = getClientPreferences();
  return {
    live: prefs.content.live ?? null,
    movies: prefs.content.movies ?? null,
    series: prefs.content.series ?? null,
  };
}

export function setContentPreferences(content: Partial<ContentPrefs>): ClientPrefs {
  return setClientPreferences({ content });
}

export function getAdultContentPreferences(): CategoryFilter {
  const prefs = getClientPreferences();
  return prefs.content.adult ?? null;
}

export function setAdultContentPreferences(adult: CategoryFilter): ClientPrefs {
  return setClientPreferences({ content: { adult } });
}

export function getPlaybackPreferences(): PlaybackPrefs {
  return getClientPreferences().playback;
}
