fn main() {
    // `generate_context!` embeds the icons (on macOS the dev build's Dock icon comes from icons/icon.icns)
    // only when this crate recompiles: rebuild it whenever an icon changes.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
