#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    openmusic_core::run(openmusic_core::Flavor::Plex, tauri::generate_context!());
}
