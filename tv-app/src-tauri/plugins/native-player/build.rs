// Tauri 2.0 plugins declare their JS-callable command names at build
// time so the auto-generated capability schemas know what permissions
// exist. We only expose `start_player` — the inline-preview surface
// from the legacy Capacitor plugin is intentionally not ported.
const COMMANDS: &[&str] = &["start_player"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
