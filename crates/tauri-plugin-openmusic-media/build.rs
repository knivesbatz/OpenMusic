// No commands are exposed to the webview: the app calls the plugin from Rust (see lib.rs).
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
