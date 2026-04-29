use serde::{Deserialize, Serialize};
use tauri::{command, AppHandle, Runtime};

use crate::{NativePlayerExt, Result};

// ────────────────────────────────────────────────────────────────────
// Fullscreen player
// ────────────────────────────────────────────────────────────────────

/// JS → native input. Mirrors the legacy Capacitor `OttPlayerPlugin#startPlayer`
/// arguments shape so the existing PlayerActivity Intent extras map across
/// without translation.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartPlayerArgs {
    pub url: String,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub channel_data: Option<String>,
    pub resume_position: Option<i64>,
}

/// Native → JS result. Mirrors the legacy `handlePlayerResult` payload.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerResult {
    pub last_position: i64,
    pub last_duration: i64,
    pub exit_reason: String,
    pub error_message: String,
    pub error_id: String,
    pub selected_subtitle_lang: String,
    pub selected_audio_lang: String,
}

#[command]
pub(crate) async fn start_player<R: Runtime>(
    app: AppHandle<R>,
    args: StartPlayerArgs,
) -> Result<PlayerResult> {
    app.native_player().start_player(args).await
}

// ────────────────────────────────────────────────────────────────────
// Inline previews — floating ExoPlayer surface positioned over the
// WebView at JS-supplied viewport coordinates.
// ────────────────────────────────────────────────────────────────────

/// Geometry for attach + update calls. `viewport_width` / `viewport_height`
/// are CSS-pixel dimensions of the WebView so the native side can scale
/// from JS coordinates into the host Activity's pixel grid.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InlinePreviewBoundsArgs {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub z_index: Option<i32>,
    pub dpr: Option<f64>,
    pub viewport_width: Option<f64>,
    pub viewport_height: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InlinePreviewPlayArgs {
    pub id: String,
    pub url: String,
    pub muted: Option<bool>,
    pub is_live: Option<bool>,
    pub start_at_sec: Option<f64>,
    pub video_codec_hint: Option<String>,
    pub audio_codec_hint: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InlinePreviewIdArgs {
    pub id: String,
}

#[command]
pub(crate) async fn attach_inline_preview<R: Runtime>(
    app: AppHandle<R>,
    args: InlinePreviewBoundsArgs,
) -> Result<()> {
    app.native_player().attach_inline_preview(args).await
}

#[command]
pub(crate) async fn update_inline_preview<R: Runtime>(
    app: AppHandle<R>,
    args: InlinePreviewBoundsArgs,
) -> Result<()> {
    app.native_player().update_inline_preview(args).await
}

#[command]
pub(crate) async fn play_inline_preview<R: Runtime>(
    app: AppHandle<R>,
    args: InlinePreviewPlayArgs,
) -> Result<()> {
    app.native_player().play_inline_preview(args).await
}

#[command]
pub(crate) async fn stop_inline_preview<R: Runtime>(
    app: AppHandle<R>,
    args: InlinePreviewIdArgs,
) -> Result<()> {
    app.native_player().stop_inline_preview(args).await
}

#[command]
pub(crate) async fn detach_inline_preview<R: Runtime>(
    app: AppHandle<R>,
    args: InlinePreviewIdArgs,
) -> Result<()> {
    app.native_player().detach_inline_preview(args).await
}

#[command]
pub(crate) async fn stop_all_inline_previews<R: Runtime>(
    app: AppHandle<R>,
) -> Result<()> {
    app.native_player().stop_all_inline_previews().await
}
