// Tauri 2.0 plugins declare their JS-callable command names at build
// time so the auto-generated capability schemas know what permissions
// exist. Order matches the order in src/lib.rs's invoke_handler!.
const COMMANDS: &[&str] = &[
    "start_player",
    "attach_inline_preview",
    "update_inline_preview",
    "play_inline_preview",
    "stop_inline_preview",
    "detach_inline_preview",
    "stop_all_inline_previews",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
