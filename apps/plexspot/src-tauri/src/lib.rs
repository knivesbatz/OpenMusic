// Entry point shared by the desktop binary (main.rs) and the Android library.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    openmusic_core::run(openmusic_core::Flavor::Plex, tauri::generate_context!());
}
