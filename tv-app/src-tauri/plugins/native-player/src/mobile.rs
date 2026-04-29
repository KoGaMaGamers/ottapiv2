use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::commands::{PlayerResult, StartPlayerArgs};
use crate::Result;

/// Java identifier the Android side uses to look up our plugin class.
/// Must match the `package` declaration in NativePlayerPlugin.kt.
#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "fr.smartbunker.symbioplayer.nativeplayer";

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> Result<NativePlayer<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "NativePlayerPlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(swift_plugin_init)?;
    Ok(NativePlayer(handle))
}

pub struct NativePlayer<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> NativePlayer<R> {
    pub async fn start_player(&self, args: StartPlayerArgs) -> Result<PlayerResult> {
        // `run_mobile_plugin` invokes the matching @Command on the
        // Android side. The string must match the Kotlin method name.
        self.0
            .run_mobile_plugin("startPlayer", args)
            .map_err(Into::into)
    }
}

// iOS not in scope yet — phase B is Android-only. When we add iOS we'd
// drop a `swift_plugin_init` extern fn here.
#[cfg(target_os = "ios")]
extern "C" {
    fn swift_plugin_init();
}
