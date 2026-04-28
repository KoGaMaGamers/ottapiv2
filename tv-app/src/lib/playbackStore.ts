/**
 * Playback progress store — backed by a single localStorage bag and a
 * Solid signal so reactive consumers (Home's Continue Watching row,
 * card progress bars) update automatically when the player saves.
 *
 * Faithful Solid port of `tv_app_v2/src/utils/playbackStore.js`. Same
 * localStorage key (`ott_playback_progress_v1`) so existing state
 * carries over from a legacy install.
 *
 * Save contract:
 *   - `savePlaybackProgress(item, { positionSec, durationSec, markCompleted })`
 *   - Skips writes below MIN_SAVE_SECONDS (10s) so accidental scrubs
 *     don't poison the store.
 *   - Auto-removes the entry when complete (>=90% watched OR within
 *     120s of the end).
 *   - Trims to MAX_ITEMS most recent entries.
 *
 * Resume contract:
 *   - `getResumePositionSec(item)` returns 0 unless there's a saved
 *     position. For a series, the same season+episode must match —
 *     opening a different episode of the same series resumes from 0.
 */

import { createSignal } from "solid-js";

const PLAYBACK_KEY = "ott_playback_progress_v1";
const PLAYBACK_EVENT = "ott-playback-progress-changed";
const MAX_ITEMS = 80;
const MIN_SAVE_SECONDS = 10;
const COMPLETE_RATIO = 0.9;
const COMPLETE_REMAINING_SECONDS = 120;

export interface PlaybackEntry {
  key: string;
  type: "movie" | "series";
  id: number | string | null;
  xtream_id: number | string | null;
  tmdb_id: number | string | null;
  /** OTT-DB series id used to dedupe series across episode entries. */
  _ottSeriesId: number | string | null;
  series_id: number | string | null;
  title: string;
  name: string;
  logo: string | null;
  backdrop: string | null;
  plot: string | null;
  rating: string | number | null;
  year: string | number | null;
  genres: string[];
  season: number;
  episode: number;
  container_extension: string | null;
  positionSec: number;
  durationSec: number;
  updatedAt: number;
}

/**
 * Loose item shape callers pass in. Only the fields actually used by
 * `getPlaybackKey` are required at the type level — the rest are
 * stored as-is for the Continue Watching row to render later.
 */
export interface PlaybackItem {
  type?: "movie" | "series" | string;
  id?: number | string | null;
  xtream_id?: number | string | null;
  tmdb_id?: number | string | null;
  _ottSeriesId?: number | string | null;
  series_id?: number | string | null;
  seriesId?: number | string | null;
  title?: string | null;
  name?: string | null;
  logo?: string | null;
  channel_logo?: string | null;
  backdrop?: string | null;
  backdrop_path?: string | null;
  plot?: string | null;
  rating?: string | number | null;
  year?: string | number | null;
  genres?: ReadonlyArray<string | { name?: string | null }>;
  season?: number | string | null;
  episode?: number | string | null;
  container_extension?: string | null;
}

type PlaybackState = Record<string, PlaybackEntry>;

// ---------------------------------------------------------------------------
// Storage backing
// ---------------------------------------------------------------------------

function readFromStorage(): PlaybackState {
  try {
    const raw = localStorage.getItem(PLAYBACK_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as PlaybackState) : {};
  } catch {
    return {};
  }
}

const [state, setState] = createSignal<PlaybackState>(readFromStorage());

/** Reactive accessor — components reading the store can wrap in createMemo. */
export const playbackState = state;

function writeToStorage(next: PlaybackState): void {
  try {
    localStorage.setItem(PLAYBACK_KEY, JSON.stringify(next));
  } catch {
    /* localStorage unavailable — keep in-memory state anyway */
  }
  setState(next);
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(new CustomEvent(PLAYBACK_EVENT));
    } catch {
      /* no DOM */
    }
  }
}

// Sync from other tabs.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === PLAYBACK_KEY) setState(readFromStorage());
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const normNum = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

const normalizeType = (v: unknown): "movie" | "series" => {
  const t = String(v ?? "").toLowerCase();
  return t === "series" ? "series" : "movie";
};

const seriesIdentity = (item: PlaybackItem): string | number | null =>
  item._ottSeriesId ??
  item.series_id ??
  item.seriesId ??
  item.id ??
  item.tmdb_id ??
  item.title ??
  item.name ??
  null;

const trim = (s: PlaybackState): PlaybackState => {
  const list = Object.values(s).sort(
    (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
  );
  if (list.length <= MAX_ITEMS) return s;
  const keep: PlaybackState = {};
  for (const item of list.slice(0, MAX_ITEMS)) keep[item.key] = item;
  return keep;
};

const isCompleted = (positionSec: number, durationSec: number): boolean => {
  if (durationSec <= 0) return false;
  return (
    positionSec >=
    Math.max(durationSec * COMPLETE_RATIO, durationSec - COMPLETE_REMAINING_SECONDS)
  );
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getPlaybackKey(item: PlaybackItem | null): string | null {
  if (!item) return null;
  const type = normalizeType(item.type);
  if (type === "movie") {
    const movieId =
      item.xtream_id ?? item.id ?? item.tmdb_id ?? item.title ?? item.name;
    return movieId == null ? null : `movie:${String(movieId)}`;
  }
  const sid = seriesIdentity(item);
  return sid == null ? null : `series:${String(sid)}`;
}

function toEntry(
  item: PlaybackItem,
  key: string,
  positionSec: number,
  durationSec: number,
): PlaybackEntry {
  const type = normalizeType(item.type);
  const genres: string[] = Array.isArray(item.genres)
    ? (item.genres
        .map((g) => (typeof g === "string" ? g : g?.name ?? null))
        .filter((g): g is string => !!g) as string[])
    : [];
  return {
    key,
    type,
    id: item.id ?? null,
    xtream_id: item.xtream_id ?? null,
    tmdb_id: item.tmdb_id ?? null,
    _ottSeriesId:
      item._ottSeriesId ?? item.series_id ?? item.seriesId ?? null,
    series_id: item.series_id ?? item.seriesId ?? item._ottSeriesId ?? null,
    title: item.title || item.name || "",
    name: item.name || item.title || "",
    logo: item.logo || item.channel_logo || null,
    backdrop: item.backdrop || item.backdrop_path || null,
    plot: item.plot || null,
    rating: item.rating || null,
    year: item.year || null,
    genres,
    season: normNum(item.season),
    episode: normNum(item.episode),
    container_extension: item.container_extension || null,
    positionSec: normNum(positionSec),
    durationSec: normNum(durationSec),
    updatedAt: Date.now(),
  };
}

export interface SaveOpts {
  positionSec?: number;
  durationSec?: number;
  markCompleted?: boolean;
}

export function savePlaybackProgress(
  item: PlaybackItem,
  opts: SaveOpts = {},
): boolean {
  const key = getPlaybackKey(item);
  if (!key) return false;
  const position = normNum(opts.positionSec);
  const duration = normNum(opts.durationSec);
  const cur = state();
  const existing = cur[key];
  const effDuration = duration > 0 ? duration : normNum(existing?.durationSec);

  if (opts.markCompleted || isCompleted(position, effDuration)) {
    if (cur[key]) {
      const next = { ...cur };
      delete next[key];
      writeToStorage(next);
    }
    return true;
  }

  if (position < MIN_SAVE_SECONDS) return false;

  const entry = toEntry(item, key, position, effDuration);
  writeToStorage(trim({ ...cur, [key]: { ...existing, ...entry } }));
  return true;
}

export function removePlaybackProgress(item: PlaybackItem | string): void {
  const key = typeof item === "string" ? item : getPlaybackKey(item);
  if (!key) return;
  const cur = state();
  if (!cur[key]) return;
  const next = { ...cur };
  delete next[key];
  writeToStorage(next);
}

export function getPlaybackProgress(
  item: PlaybackItem | string,
): PlaybackEntry | null {
  const key = typeof item === "string" ? item : getPlaybackKey(item);
  if (!key) return null;
  return state()[key] ?? null;
}

export function getResumePositionSec(item: PlaybackItem): number {
  const progress = getPlaybackProgress(item);
  if (!progress) return 0;

  // For series, only resume if the user reopens the same episode.
  // Picking a different episode of the same series should start at 0.
  if (normalizeType(item.type) === "series") {
    const tS = normNum(item.season);
    const tE = normNum(item.episode);
    const sS = normNum(progress.season);
    const sE = normNum(progress.episode);
    if (tS > 0 && tE > 0 && (tS !== sS || tE !== sE)) return 0;
  }

  return normNum(progress.positionSec);
}

/**
 * Items shaped for the Home Continue Watching row. The `__progressPct
 * / __resumeSec / __durationSec` fields piggy-back on the CardItem
 * shape so MovieMediaCard / SeriesMediaCard render the progress bar
 * automatically (see components/cardItem.ts → computeProgressPct).
 */
export interface ContinueItem extends PlaybackEntry {
  __resumeSec: number;
  __durationSec: number;
  __progressPct: number | null;
}

export function getContinueWatchingItems(limit = 20): ContinueItem[] {
  const s = state();
  const deduped = new Map<string, PlaybackEntry>();
  for (const entry of Object.values(s)) {
    if (!entry || (entry.type !== "movie" && entry.type !== "series")) continue;
    const groupKey =
      entry.type === "series"
        ? `series:${String(seriesIdentity(entry) ?? entry.key ?? "")}`
        : `movie:${String(
            entry.xtream_id ?? entry.id ?? entry.tmdb_id ?? entry.key ?? "",
          )}`;
    const prev = deduped.get(groupKey);
    if (!prev || (entry.updatedAt || 0) > (prev.updatedAt || 0)) {
      deduped.set(groupKey, entry);
    }
  }
  return Array.from(deduped.values())
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, Math.max(1, Number(limit) || 20))
    .map((x) => ({
      ...x,
      __resumeSec: normNum(x.positionSec),
      __durationSec: normNum(x.durationSec),
      __progressPct:
        x.durationSec > 0
          ? Math.round((x.positionSec / x.durationSec) * 100)
          : null,
    }));
}
