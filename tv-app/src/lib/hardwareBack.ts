/**
 * Hardware back handler — single source of truth for Android back.
 *
 * Why this exists
 * ---------------
 * In Tauri Android, a hardware back press fires at TWO independent
 * layers and the resulting double-fire was overshooting the route to
 * /home and occasionally exiting the app:
 *
 *   1. Activity layer (WryActivity / TauriActivity): Tauri registers
 *      an OnBackPressedCallback that calls webView.goBack(), which
 *      pops the SPA route. We disable this in the host MainActivity
 *      override (see INTEGRATION.md → MainActivity.kt template) by
 *      setting `handleBackNavigation = false` and adding a no-op
 *      OnBackPressedCallback so the Activity default doesn't finish().
 *
 *   2. WebView layer: the WebView dispatches a keydown event with
 *      key="BrowserBack". This file owns it. We capture in capture
 *      phase, suppress the original (preventDefault +
 *      stopImmediatePropagation) so no other listener double-fires,
 *      then synthesise an Escape keydown so existing back-aware
 *      components — modals, players, page nav — fire normally
 *      through the scope-stack guard. Escape is in BACK_KEYS so
 *      isBackKey() recognises it.
 *
 * Layer 1 + this layer 2 handler together make the scope stack the
 * only place hardware back is routed through. Browser dev is
 * unaffected because BrowserBack is an Android-specific key — desktop
 * Escape/Backspace flow through the natural keydown path as before.
 */

let installed = false;

/** Marker so the synthesised Escape isn't re-trapped by us. */
const SYNTH_FLAG = "__symbioBackSynth";

/**
 * While true, hardware back events are swallowed entirely — no
 * synthetic Escape is dispatched. Set by NativePlayerHost while the
 * native ExoPlayer Activity is in the foreground, because back presses
 * inside the native overlay also leak as BrowserBack to the WebView.
 */
let _nativePlayerActive = false;
export function setNativePlayerActive(active: boolean): void {
  _nativePlayerActive = active;
}

/**
 * Android hardware back surfaces under a few key names depending on
 * the WebView version / vendor. Cover all the variants we've seen.
 */
const HARDWARE_BACK_KEYS = new Set(["BrowserBack", "GoBack", "Back"]);

export function installHardwareBackHandler(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (!HARDWARE_BACK_KEYS.has(e.key)) return;
      if ((e as unknown as Record<string, unknown>)[SYNTH_FLAG]) return;

      // Always suppress the WebView's default history.back().
      e.preventDefault();
      e.stopImmediatePropagation();

      // While the native ExoPlayer Activity is in the foreground,
      // swallow entirely — PlayerActivity handles its own back via
      // onKeyDown/onKeyUp. The BrowserBack that leaks here is a
      // ghost event; synthesising Escape would close the allocation.
      if (_nativePlayerActive) return;

      // Synthesise a single Escape at the focused element so the
      // scope-stack handlers process it.
      const synth = new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        keyCode: 27,
        which: 27,
        bubbles: true,
        cancelable: true,
      });
      (synth as unknown as Record<string, unknown>)[SYNTH_FLAG] = true;
      const target = document.activeElement ?? document.body;
      target.dispatchEvent(synth);
    },
    { capture: true },
  );
}
