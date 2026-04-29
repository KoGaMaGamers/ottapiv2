//! Symbioplayer native (ExoPlayer) player plugin.
//!
//! Single command exposed to JS: `start_player`. JS hands over a stream
//! URL + metadata; native launches a fullscreen ExoPlayer Activity;
//! returns the final playback position (and exit reason / errors /
//! selected lang prefs) so the JS layer can persist progress through
//! the existing playbackStore / historyStore / watchlist chain.
//!
//! The actual ExoPlayer + Android UI lives in the lifted Kotlin sources
//! under `android/src/main/java/fr/smartbunker/symbioplayer/nativeplayer/`
//! (PlayerActivity, ExoPlayerManager, VodOverlayManager, LiveOverlayManager,
//! SubtitleManager, EpgService, ChannelData) — verbatim port from the
//! legacy Capacitor app.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod commands;
mod error;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

pub use error::{Error, Result};

#[cfg(desktop)]
use desktop::NativePlayer;
#[cfg(mobile)]
use mobile::NativePlayer;

/// Extension trait so `app.native_player()` works anywhere a `Manager`
/// reference is in hand — same pattern Tauri's first-party plugins use.
pub trait NativePlayerExt<R: Runtime> {
    fn native_player(&self) -> &NativePlayer<R>;
}

impl<R: Runtime, T: Manager<R>> crate::NativePlayerExt<R> for T {
    fn native_player(&self) -> &NativePlayer<R> {
        self.state::<NativePlayer<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("native-player")
        .invoke_handler(tauri::generate_handler![
            commands::start_player,
            commands::attach_inline_preview,
            commands::update_inline_preview,
            commands::play_inline_preview,
            commands::stop_inline_preview,
            commands::detach_inline_preview,
            commands::stop_all_inline_previews,
        ])
        .setup(|app, api| {
            #[cfg(mobile)]
            let native_player = mobile::init(app, api)?;
            #[cfg(desktop)]
            let native_player = desktop::init(app, api)?;
            app.manage(native_player);
            Ok(())
        })
        .build()
}
