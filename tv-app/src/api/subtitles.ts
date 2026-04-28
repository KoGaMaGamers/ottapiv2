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
 * Same-origin URL for the player's <track> element. Browsers refuse to
 * load cross-origin VTT into a <track> unless the video element is in
 * CORS mode — and putting the video into CORS mode makes the provider
 * stream URLs (which don't send CORS headers) fail to play. So we
 * always return a relative path that resolves through the Vite dev
 * proxy (same-origin) and against VITE_API_BASE in prod.
 *
 * The backend's `entry.url_vtt` is an absolute URL built from
 * request.base_url; we ignore it here and construct the well-known
 * path from `entry.id` instead.
 */
export function subtitleVttUrl(entry: SubtitleEntry): string {
  const path = `/api/v1/subtitles/${entry.id}`;
  const base = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";
  return base ? base.replace(/\/+$/, "") + path : path;
}
