/**
 * Native player bridge — wraps the Tauri 2.0 `native-player` plugin.
 *
 * On Android (Tauri context) we route VOD + Live playback through the
 * lifted ExoPlayer Activity instead of the WebView's `<video>` element.
 * The fullscreen activity returns the final position / duration / exit
 * reason / language picks via Tauri's mobile invoke channel; the JS
 * caller plugs that into the existing playbackStore / historyStore /
 * watchlistStore chain so the rest of the app behaves identically to
 * the browser-`<video>` flow.
 *
 * Hero preview clips intentionally stay on the WebView — the ExoPlayer
 * SurfaceView can't reproduce the CSS-driven fadeout of the hero
 * background, so the inline-preview methods from the legacy Capacitor
 * plugin were not ported.
 */

import { invoke } from "@tauri-apps/api/core";

/** Detect Tauri at runtime — same check the API client uses. */
export function isTauriContext(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as {
    __TAURI_INTERNALS__?: unknown;
    isTauri?: unknown;
  };
  return Boolean(w.__TAURI_INTERNALS__) || w.isTauri === true;
}

/**
 * Native player is only available on Android — desktop Tauri builds
 * fall back to the WebView `<video>` path.
 *
 * Tauri 2.0 doesn't expose a synchronous platform getter; we read the
 * UA as a proxy. Anything matching "Android" inside a Tauri WebView
 * means the native plugin is reachable.
 */
export function isNativePlayerAvailable(): boolean {
  if (!isTauriContext()) return false;
  if (typeof navigator === "undefined") return false;
  return /Android/i.test(navigator.userAgent);
}

export interface LaunchPlayerArgs {
  /** Direct stream URL — same one the WebView <video> would load. */
  url: string;
  /** "live" | "movie" | "episode". Drives overlay style. */
  type: "live" | "movie" | "episode";
  /** Display title in the overlay. Movie/series name, channel name, etc. */
  title?: string;
  /** Display subtitle. Episode "S01E03 · …", channel category, etc. */
  subtitle?: string;
  /**
   * JSON-encoded blob the native overlay parses for type-specific
   * data (EPG, episode list, season metadata). The Kotlin side
   * deserialises via `ChannelData.kt`. Passed as a string so we
   * don't have to mirror its full schema in TS.
   */
  channelData?: string;
  /** Resume position in ms. 0 = start from beginning. */
  resumePosition?: number;
}

export interface PlayerResult {
  /** Final playback position in ms when the activity closed. */
  lastPosition: number;
  /** Detected media duration in ms. */
  lastDuration: number;
  /** "back" | "error" | "cancelled" | "finished" | "zap" — diagnostic. */
  exitReason: string;
  /** Populated when exitReason === "error". */
  errorMessage: string;
  /** Provider-specific error code when present. */
  errorId: string;
  /** Last subtitle language the user picked (for prefs auto-apply). */
  selectedSubtitleLang: string;
  /** Last audio language the user picked. */
  selectedAudioLang: string;
}

/**
 * Launch the fullscreen native player. Resolves when the activity
 * closes. Throws on platforms where the plugin isn't available
 * (desktop Tauri / browser dev) — callers should guard with
 * `isNativePlayerAvailable()` first.
 */
export function launchNativePlayer(args: LaunchPlayerArgs): Promise<PlayerResult> {
  return invoke<PlayerResult>("plugin:native-player|start_player", { args });
}

// ---------------------------------------------------------------------------
// Inline previews — floating ExoPlayer surface over the WebView
// ---------------------------------------------------------------------------
//
// Used by the Live page hero: the focused channel plays inline in a
// native PlayerView positioned at JS-supplied viewport coordinates,
// because the WebView <video> path can't load IPTV streams (no CORS).
//
// Lifecycle the caller is expected to drive:
//   1. attachInlinePreview(payload) — creates the native session
//      with starting bounds (left/top/width/height in CSS pixels) +
//      the WebView's viewport size for coordinate mapping.
//   2. playInlinePreview({id, url, ...}) — starts playback.
//   3. updateInlinePreview(payload) — call whenever the slot resizes
//      / scrolls / the viewport changes.
//   4. stopInlinePreview({id}) — stop playback (keeps the surface).
//   5. detachInlinePreview({id}) — release surface + ExoPlayer.
//
// Or `stopAllInlinePreviews()` as a global escape hatch (e.g. before
// launching the fullscreen player).

export interface InlinePreviewBounds {
  /** Stable id per surface — random suffix per logical preview slot. */
  id: string;
  /** CSS pixel coordinates relative to the WebView's top-left. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Stack order; defaults to 1000. */
  zIndex?: number;
  /** Device pixel ratio. Currently unused by the native side
   *  (it scales by viewport pixels) but kept for parity with the
   *  legacy API. */
  dpr?: number;
  viewportWidth?: number;
  viewportHeight?: number;
}

export interface InlinePreviewPlay {
  id: string;
  url: string;
  muted?: boolean;
  isLive?: boolean;
  startAtSec?: number;
  videoCodecHint?: string;
  audioCodecHint?: string;
}

export function attachInlinePreview(args: InlinePreviewBounds): Promise<void> {
  return invoke("plugin:native-player|attach_inline_preview", { args });
}

export function updateInlinePreview(args: InlinePreviewBounds): Promise<void> {
  return invoke("plugin:native-player|update_inline_preview", { args });
}

export function playInlinePreview(args: InlinePreviewPlay): Promise<void> {
  return invoke("plugin:native-player|play_inline_preview", { args });
}

export function stopInlinePreview(id: string): Promise<void> {
  return invoke("plugin:native-player|stop_inline_preview", { args: { id } });
}

export function detachInlinePreview(id: string): Promise<void> {
  return invoke("plugin:native-player|detach_inline_preview", { args: { id } });
}

export function stopAllInlinePreviews(): Promise<void> {
  return invoke("plugin:native-player|stop_all_inline_previews");
}
