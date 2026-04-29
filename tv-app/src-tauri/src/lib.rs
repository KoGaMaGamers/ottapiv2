// Shared entry point for desktop + mobile. The `mobile_entry_point`
// attribute lets Android's JNI loader call this fn directly; on
// desktop the binary in main.rs forwards into it instead.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_native_player::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
