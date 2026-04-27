import { api } from "./client";
import type { SubtitleEntry } from "./types";

/**
 * Subtitle metadata + cached VTT served from the backend.
 *
 *   listSubtitles   → backend hits SUBDL on cache MISS, downloads zip,
 *                     converts to VTT, persists. Subsequent calls served
 *                     from DB cache, no upstream traffic.
 *   subtitleVttUrl  → returns the absolute URL the player can pass to
 *                     <track src="…"> or fetch directly. The backend
 *                     serves it as text/vtt with a 7-day Cache-Control.
 */

export interface ListSubtitlesOpts {
  tmdb_id: number;
  /** Comma-separated 2-letter codes, e.g. "en,fr". Omit for all. */
  lang?: string;
  /** Series episode — both required together. Omit for movies. */
  season?: number;
  episode?: number;
}

function qs(params: object): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export function listSubtitles(opts: ListSubtitlesOpts): Promise<SubtitleEntry[]> {
  return api.get<SubtitleEntry[]>(`/api/v1/subtitles${qs(opts)}`);
}

/**
 * The backend returns a `url_vtt` field on each SubtitleEntry that may be
 * absolute (when called from a deployed frontend) or relative (when called
 * via the Vite dev proxy). Use this helper to coerce to the right shape.
 */
export function subtitleVttUrl(entry: SubtitleEntry): string {
  const base = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";
  if (entry.url_vtt.startsWith("http")) return entry.url_vtt;
  if (!base) return entry.url_vtt;
  return base.replace(/\/+$/, "") + entry.url_vtt;
}
