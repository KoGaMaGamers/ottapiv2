use serde::de::DeserializeOwned;
use std::marker::PhantomData;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::commands::{
    InlinePreviewBoundsArgs, InlinePreviewIdArgs, InlinePreviewPlayArgs, PlayerResult,
    StartPlayerArgs,
};
use crate::{Error, Result};

/// Desktop builds keep the API surface compilable but every call returns
/// `Error::NotAvailable`. The webview's `<video>` path is the desktop
/// fallback (see `MediaPlayer.tsx` — `isNativePlayerAvailable()` is false
/// there, so the player never tries to invoke us).
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> Result<NativePlayer<R>> {
    Ok(NativePlayer(PhantomData))
}

pub struct NativePlayer<R: Runtime>(PhantomData<R>);

impl<R: Runtime> NativePlayer<R> {
    pub async fn start_player(&self, _args: StartPlayerArgs) -> Result<PlayerResult> {
        Err(Error::NotAvailable)
    }

    pub async fn attach_inline_preview(&self, _args: InlinePreviewBoundsArgs) -> Result<()> {
        Err(Error::NotAvailable)
    }

    pub async fn update_inline_preview(&self, _args: InlinePreviewBoundsArgs) -> Result<()> {
        Err(Error::NotAvailable)
    }

    pub async fn play_inline_preview(&self, _args: InlinePreviewPlayArgs) -> Result<()> {
        Err(Error::NotAvailable)
    }

    pub async fn stop_inline_preview(&self, _args: InlinePreviewIdArgs) -> Result<()> {
        Err(Error::NotAvailable)
    }

    pub async fn detach_inline_preview(&self, _args: InlinePreviewIdArgs) -> Result<()> {
        Err(Error::NotAvailable)
    }

    pub async fn stop_all_inline_previews(&self) -> Result<()> {
        Err(Error::NotAvailable)
    }
}
