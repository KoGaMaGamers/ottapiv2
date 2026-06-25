/**
 * Watchlist store — localStorage-backed list of saved movies/series.
 *
 * Faithful Solid port of `tv_app_v2/src/utils/watchlistStore.js`. Same
 * key (`ott_watchlist_v1`) so legacy state migrates. Surfaced as a
 * Solid signal so card/menu components reactively reflect state
 * without manual subscribe/unsubscribe.
 *
 * Auto-cleanup: when the playback store purges an entry as
 * "completed" (>=90% watched / <120s remaining), the matching
 * watchlist row is removed too — see playbackStore.ts for the wire-up.
 */

import { createSignal } from "solid-js";

const WATCHLIST_KEY = "ott_watchlist_v1";
const WATCHLIST_EVENT = "ott-watchlist-changed";
const MAX_WATCHLIST = 300;

export interface WatchlistItem {
  key: string;
  type: "movie" | "series";
  id: number | string | null;
  xtream_id: number | string | null;
  tmdb_id: number | string | null;
  title: string;
  name: string;
  logo: string | null;
  backdrop: string | null;
  plot: string | null;
  rating: string | number | null;
  language: string | null;
  year: string | number | null;
  genres: string[];
  container_extension: string | null;
  savedAt: number;
}

/**
 * Loose item shape callers pass in. Same probe pattern as the
 * playback store — the watchlist accepts whatever the page already
 * has on hand and normalises internally.
 */
export interface WatchlistItemInput {
  type?: "movie" | "series" | string;
  id?: number | string | null;
  xtream_id?: number | string | null;
  tmdb_id?: number | string | null;
  title?: string | null;
  name?: string | null;
  logo?: string | null;
  cover?: string | null;
  stream_icon?: string | null;
  channel_logo?: string | null;
  backdrop?: string | null;
  backdrop_path?: string | null;
  plot?: string | null;
  rating?: string | number | null;
  language?: string | null;
  year?: string | number | null;
  genres?: ReadonlyArray<string | { name?: string | null }>;
  container_extension?: string | null;
  /** When true, the item belongs to an adult category — never added. */
  is_adult?: boolean;
}

// ---------------------------------------------------------------------------
// Storage backing
// ---------------------------------------------------------------------------

function readFromStorage(): WatchlistItem[] {
  try {
    const raw = localStorage.getItem(WATCHLIST_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as WatchlistItem[]) : [];
  } catch {
    return [];
  }
}

const [state, setState] = createSignal<WatchlistItem[]>(readFromStorage());

/** Reactive accessor — components reading the store can wrap in createMemo. */
export const watchlistState = state;

function writeToStorage(next: WatchlistItem[]): void {
  try {
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify(next));
  } catch {
    /* localStorage unavailable */
  }
  setState(next);
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(new CustomEvent(WATCHLIST_EVENT));
    } catch {
      /* no DOM */
    }
  }
}

// Sync from other tabs.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === WATCHLIST_KEY) setState(readFromStorage());
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const normalizeType = (v: unknown): "movie" | "series" => {
  const t = String(v ?? "").toLowerCase();
  return t === "series" ? "series" : "movie";
};

export function getWatchlistKey(
  item: WatchlistItemInput | null,
): string | null {
  if (!item) return null;
  const type = normalizeType(item.type);
  const rawId =
    item.xtream_id ?? item.id ?? item.tmdb_id ?? item.title ?? item.name;
  return rawId == null ? null : `${type}:${String(rawId)}`;
}

function normalizeItem(
  item: WatchlistItemInput,
  key: string,
): WatchlistItem {
  const genres: string[] = Array.isArray(item.genres)
    ? (item.genres
        .map((g) => (typeof g === "string" ? g : g?.name ?? null))
        .filter((g): g is string => !!g) as string[])
    : [];
  return {
    key,
    type: normalizeType(item.type),
    id: item.id ?? null,
    xtream_id: item.xtream_id ?? null,
    tmdb_id: item.tmdb_id ?? null,
    title: item.title || item.name || "",
    name: item.name || item.title || "",
    logo:
      item.logo ||
      item.cover ||
      item.stream_icon ||
      item.channel_logo ||
      null,
    backdrop: item.backdrop || item.backdrop_path || null,
    plot: item.plot || null,
    rating: item.rating || null,
    language: item.language || null,
    year: item.year || null,
    genres,
    container_extension: item.container_extension || null,
    savedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Most-recent first. */
export function listWatchlist(): WatchlistItem[] {
  return [...state()].sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

export function isInWatchlist(item: WatchlistItemInput | null): boolean {
  const key = getWatchlistKey(item);
  if (!key) return false;
  return state().some((x) => x.key === key);
}

export function addWatchlistItem(item: WatchlistItemInput): boolean {
  // Adult content is excluded from every regular-content feature.
  if (item.is_adult) return false;
  const key = getWatchlistKey(item);
  if (!key) return false;
  const cur = state();
  const filtered = cur.filter((x) => x.key !== key);
  filtered.unshift(normalizeItem(item, key));
  writeToStorage(filtered.slice(0, MAX_WATCHLIST));
  return true;
}

export function removeWatchlistItem(
  item: WatchlistItemInput | string,
): boolean {
  const key = typeof item === "string" ? item : getWatchlistKey(item);
  if (!key) return false;
  const cur = state();
  const next = cur.filter((x) => x.key !== key);
  if (next.length === cur.length) return false;
  writeToStorage(next);
  return true;
}

/** Returns the new state — true if added, false if removed. */
export function toggleWatchlistItem(item: WatchlistItemInput): boolean {
  if (item.is_adult) return false; // adult content is never added
  if (isInWatchlist(item)) {
    removeWatchlistItem(item);
    return false;
  }
  addWatchlistItem(item);
  return true;
}
