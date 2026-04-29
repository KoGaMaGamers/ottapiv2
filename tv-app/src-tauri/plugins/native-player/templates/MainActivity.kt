/*
 * Canonical MainActivity for Symbioplayer's Tauri Android host.
 *
 * Copy this file (verbatim) to:
 *   gen/android/app/src/main/java/fr/smartbunker/symbioplayer/MainActivity.kt
 * after every `cargo tauri android init`. Tauri's generator clobbers
 * gen/android/, so this template is the only durable source of truth.
 * (See INTEGRATION.md for the full integration recipe.)
 *
 * What this file does
 * -------------------
 * Disables Tauri's default hardware-back handling so the JS layer
 * (lib/hardwareBack.ts → scope-stack arbitration) is the *only*
 * source that processes back presses. Without this override, hardware
 * back fires at two layers — Activity (webView.goBack) and WebView
 * (BrowserBack keydown) — and the duplicate-fire was overshooting
 * the SPA route to /home or exiting the app entirely.
 *
 * Two changes from the Tauri default:
 *
 *   1. `override val handleBackNavigation = false` — tells Tauri's
 *      base class to skip its OnBackPressedCallback registration.
 *      Without this, Tauri calls webView.goBack() before our JS even
 *      sees the press.
 *
 *   2. An empty OnBackPressedCallback registered in onCreate. With
 *      Tauri's callback gone, Android falls through to
 *      super.onBackPressed() which finishes the Activity (= app
 *      exit). The no-op callback intercepts and swallows so the
 *      Activity never finishes. The hardware back press now ONLY
 *      surfaces as the WebView's BrowserBack keydown, which
 *      hardwareBack.ts converts to a synthetic Escape and routes
 *      through the existing component scope handlers.
 *
 * PlayerActivity (the lifted ExoPlayer activity) is unaffected — it
 * has its own OnBackPressedDispatcher callback (see PlayerActivity.kt)
 * and finishes itself with a result on back, which is what we want.
 */
package fr.smartbunker.symbioplayer

import android.os.Bundle
import androidx.activity.OnBackPressedCallback

class MainActivity : TauriActivity() {

    override val handleBackNavigation: Boolean = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    // Intentionally empty — JS owns the back gesture.
                    // The WebView still dispatches BrowserBack as a
                    // keydown event; lib/hardwareBack.ts captures it.
                }
            },
        )
    }
}
