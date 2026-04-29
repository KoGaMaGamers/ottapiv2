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
      // Only intercept the Android hardware back keys. Desktop
      // Escape / Backspace flow naturally — components already
      // handle them via isBackKey().
      if (!HARDWARE_BACK_KEYS.has(e.key)) return;

      // Pass-through if we synthesised this event ourselves —
      // capture phase fires for the synthetic too without this
      // guard.
      if ((e as unknown as Record<string, unknown>)[SYNTH_FLAG]) return;

      // 1) Suppress the WebView's default (history.back() pops the
      //    SPA route).
      // 2) Stop other listeners on the original so handlers don't
      //    run twice (once for the original, once for the synthetic
      //    Escape we're about to dispatch).
      e.preventDefault();
      e.stopImmediatePropagation();

      // 3) Synthesise a single Escape dispatched at the focused
      //    element. Bubbles so window-level listeners (page nav,
      //    modal handlers, player overlay) still see it. Existing
      //    components consume via preventDefault on this synthetic
      //    just like a regular keypress.
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
