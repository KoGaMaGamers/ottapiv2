use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::commands::{
    InlinePreviewBoundsArgs, InlinePreviewIdArgs, InlinePreviewPlayArgs, PlayerResult,
    StartPlayerArgs,
};
use crate::Result;

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
        self.0
            .run_mobile_plugin("startPlayer", args)
            .map_err(Into::into)
    }

    pub async fn attach_inline_preview(&self, args: InlinePreviewBoundsArgs) -> Result<()> {
        self.0
            .run_mobile_plugin::<()>("attachInlinePreview", args)
            .map_err(Into::into)
    }

    pub async fn update_inline_preview(&self, args: InlinePreviewBoundsArgs) -> Result<()> {
        self.0
            .run_mobile_plugin::<()>("updateInlinePreview", args)
            .map_err(Into::into)
    }

    pub async fn play_inline_preview(&self, args: InlinePreviewPlayArgs) -> Result<()> {
        self.0
            .run_mobile_plugin::<()>("playInlinePreview", args)
            .map_err(Into::into)
    }

    pub async fn stop_inline_preview(&self, args: InlinePreviewIdArgs) -> Result<()> {
        self.0
            .run_mobile_plugin::<()>("stopInlinePreview", args)
            .map_err(Into::into)
    }

    pub async fn detach_inline_preview(&self, args: InlinePreviewIdArgs) -> Result<()> {
        self.0
            .run_mobile_plugin::<()>("detachInlinePreview", args)
            .map_err(Into::into)
    }

    pub async fn stop_all_inline_previews(&self) -> Result<()> {
        self.0
            .run_mobile_plugin::<()>("stopAllInlinePreviews", ())
            .map_err(Into::into)
    }
}

#[cfg(target_os = "ios")]
extern "C" {
    fn swift_plugin_init();
}
