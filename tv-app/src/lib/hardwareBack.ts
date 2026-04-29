/**
 * Hardware back handler — single source of truth for Android back.
 *
 * Uses Tauri's built-in `onBackButtonPress` API (added in v2.9) which
 * completely replaces the default webView.goBack() behavior. When a
 * listener is registered, Tauri suppresses the Activity-level back
 * handling and fires a JS event instead — no double-fire, no
 * BrowserBack keydown, no custom MainActivity override needed.
 *
 * We synthesise an Escape keydown so existing back-aware components
 * (modals, players, page zone handlers) work unchanged through the
 * scope-stack guard. Browser dev is unaffected — this only runs in
 * Tauri Android context.
 */

import { onBackButtonPress } from "@tauri-apps/api/app";

let installed = false;

/**
 * While true, hardware back events are swallowed entirely — no
 * synthetic Escape is dispatched. Set by NativePlayerHost while the
 * native ExoPlayer Activity is in the foreground.
 */
let _nativePlayerActive = false;
export function setNativePlayerActive(active: boolean): void {
  _nativePlayerActive = active;
}

export function installHardwareBackHandler(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  // Only install in Tauri context
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (!w.__TAURI_INTERNALS__) return;

  onBackButtonPress(() => {
    // While the native ExoPlayer Activity is in the foreground,
    // swallow entirely — PlayerActivity handles its own back.
    if (_nativePlayerActive) return;

    // Synthesise a single Escape at the focused element so the
    // scope-stack handlers process it — one event, one zone
    // transition per press.
    const synth = new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      keyCode: 27,
      which: 27,
      bubbles: true,
      cancelable: true,
    });
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(synth);
  });
}
