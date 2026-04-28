// Suppress the spawn-a-console window on Windows release builds. Removing
// this line makes a black cmd.exe flash behind every app launch.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    symbioplayer_lib::run()
}
