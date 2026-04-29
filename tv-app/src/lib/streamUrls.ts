/**
 * Client-side xtream URL builders.
 *
 * Mirrors the legacy Capacitor app's `_session_required` builder set
 * (tv_app_v2/src/utils/authService.js → buildLiveUrl / buildCatchupUrl
 * / buildVodUrl / buildSeriesUrl). Each takes the user's xtream
 * credentials + a stream id and produces a direct provider URL.
 *
 * Used by:
 *   - NativePlayerHost — feeds these (or just the components) to the
 *     native ExoPlayer plugin via `channelData`. Native rebuilds zap
 *     and catchup URLs locally for the same channel set without any
 *     /api/v1/play round-trip.
 *   - HeroCarousel live preview (Phase 3) — builds the inline-preview
 *     URL the same way.
 *
 * Why no slot allocation here
 * ---------------------------
 * For live channels, donor slot allocation is a "recommendation, not
 * a restriction" (per user direction). User-creds-direct works the
 * same as the legacy app and avoids round-trips on zap. Movies and
 * episodes still go through /api/v1/play/{movie,episode} for slot
 * management — this file is live-focused for now.
 */

import type { UserCredentials } from "../api/me";

function normaliseExt(preferred: string | null | undefined): "m3u8" | "ts" {
  return (preferred ?? "").trim().toLowerCase() === "ts" ? "ts" : "m3u8";
}

/**
 * `{base}/live/{user}/{pass}/{stream_id}.{m3u8|ts}` — the direct live
 * stream URL. No slot allocation, no heartbeat.
 */
export function buildLiveUrl(
  creds: UserCredentials,
  streamId: number | string,
): string {
  const ext = normaliseExt(creds.preferred_output);
  const base = creds.base_stream_url.replace(/\/+$/, "");
  return `${base}/live/${creds.username}/${creds.password}/${streamId}.${ext}`;
}

/**
 * `{base}/timeshift/{user}/{pass}/{duration_min}/{YYYY-MM-DD:HH-MM}/{stream_id}.{ext}`
 * — catchup / timeshift URL for a past EPG entry. The native side
 * owns the EPG-driven decision of which entry to play, but for cases
 * where JS wants to pre-build the URL (e.g. inline preview) the same
 * format applies.
 */
export function buildCatchupUrl(
  creds: UserCredentials,
  streamId: number | string,
  durationMinutes: number,
  startFormatted: string,
): string {
  const ext = normaliseExt(creds.preferred_output);
  const base = creds.base_stream_url.replace(/\/+$/, "");
  return `${base}/timeshift/${creds.username}/${creds.password}/${durationMinutes}/${startFormatted}/${streamId}.${ext}`;
}
