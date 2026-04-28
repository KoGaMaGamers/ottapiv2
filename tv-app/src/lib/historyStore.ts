/**
 * Completed-history store — captures items the user finished
 * (≥90% watched / <120s remaining), used as the seed pool for the
 * "You should like…" Home row.
 *
 * Why this is separate from playbackStore
 * ---------------------------------------
 * playbackStore purges entries on completion so Continue Watching
 * doesn't show finished content. That same purge moment is exactly
 * when we want to remember "the user finished this" — but the
 * playback store is the wrong place to keep it (it'd resurface as a
 * Continue Watching row otherwise). The history store is a thin,
 * append-only log of the user's completion signal — kept lean (≤50
 * entries, identity fields only) so it can ride along in localStorage
 * without bloat.
 *
 * The recommendations endpoint reads recent entries from this store
 * directly (no server-side history); the user's playback never leaves
 * the device.
 */

import { createSignal } from "solid-js";

const HISTORY_KEY = "ott_history_v1";
const HISTORY_EVENT = "ott-history-changed";
const MAX_HISTORY = 50;

export interface HistoryEntry {
  key: string;
  type: "movie" | "series";
  /** Local catalog id — used to suppress this row from recommendations. */
  id: number | string | null;
  tmdb_id: number | string | null;
  title: string;
  genres: string[];
  year: number | string | null;
  completedAt: number;
}

/** Loose input shape — same fields the playback / watchlist stores use. */
export interface HistoryInput {
  type?: "movie" | "series" | string;
  id?: number | string | null;
  tmdb_id?: number | string | null;
  _ottSeriesId?: number | string | null;
  series_id?: number | string | null;
  title?: string | null;
  name?: string | null;
  genres?: ReadonlyArray<string | { name?: string | null }>;
  year?: number | string | null;
}

// ---------------------------------------------------------------------------
// Storage backing
// ---------------------------------------------------------------------------

function readFromStorage(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

const [state, setState] = createSignal<HistoryEntry[]>(readFromStorage());

export const historyState = state;

function writeToStorage(next: HistoryEntry[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* localStorage unavailable */
  }
  setState(next);
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(new CustomEvent(HISTORY_EVENT));
    } catch {
      /* no DOM */
    }
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === HISTORY_KEY) setState(readFromStorage());
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const normalizeType = (v: unknown): "movie" | "series" => {
  const t = String(v ?? "").toLowerCase();
  return t === "series" ? "series" : "movie";
};

function buildKey(item: HistoryInput): string | null {
  const type = normalizeType(item.type);
  if (type === "series") {
    const sid =
      item._ottSeriesId ??
      item.series_id ??
      item.id ??
      item.tmdb_id ??
      item.title ??
      item.name;
    return sid == null ? null : `series:${String(sid)}`;
  }
  const mid = item.id ?? item.tmdb_id ?? item.title ?? item.name;
  return mid == null ? null : `movie:${String(mid)}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Most-recent first. */
export function listHistory(): HistoryEntry[] {
  return [...state()].sort(
    (a, b) => (b.completedAt || 0) - (a.completedAt || 0),
  );
}

export function recordCompleted(item: HistoryInput): boolean {
  const key = buildKey(item);
  if (!key) return false;
  const genres: string[] = Array.isArray(item.genres)
    ? (item.genres
        .map((g) => (typeof g === "string" ? g : g?.name ?? null))
        .filter((g): g is string => !!g) as string[])
    : [];
  const entry: HistoryEntry = {
    key,
    type: normalizeType(item.type),
    id: item.id ?? null,
    tmdb_id: item.tmdb_id ?? null,
    title: (item.title || item.name || "") as string,
    genres,
    year: item.year ?? null,
    completedAt: Date.now(),
  };
  const cur = state();
  const filtered = cur.filter((x) => x.key !== key);
  filtered.unshift(entry);
  writeToStorage(filtered.slice(0, MAX_HISTORY));
  return true;
}

export function clearHistory(): void {
  writeToStorage([]);
}
