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
