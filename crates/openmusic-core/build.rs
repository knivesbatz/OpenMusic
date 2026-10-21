// `desktop` / `mobile` cfgs, like tauri-build sets for app crates. OPENMUSIC_CHECK_MOBILE=1
// compiles the mobile code paths on a desktop host (`cargo check`) to catch errors without an
// Android toolchain.
fn main() {
    println!("cargo::rustc-check-cfg=cfg(mobile)");
    println!("cargo::rustc-check-cfg=cfg(desktop)");
    println!("cargo:rerun-if-env-changed=OPENMUSIC_CHECK_MOBILE");
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if os == "android" || os == "ios" || std::env::var_os("OPENMUSIC_CHECK_MOBILE").is_some() {
        println!("cargo:rustc-cfg=mobile");
    } else {
        println!("cargo:rustc-cfg=desktop");
    }
}
