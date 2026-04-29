use serde::{Deserialize, Serialize};
use tauri::{command, AppHandle, Runtime};

use crate::{NativePlayerExt, Result};

/// JS → native input. Mirrors the legacy Capacitor `OttPlayerPlugin#startPlayer`
/// arguments shape so the existing PlayerActivity Intent extras map across
/// without translation.
///
/// `r#type` keeps the Rust keyword escape (we want the JSON key `type`); the
/// Android side reads it as a plain `type` field.
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

/// Native → JS result. Mirrors the legacy `handlePlayerResult` payload so
/// MediaPlayer.tsx can reuse the existing position-save / completion-record
/// chain unchanged.
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
