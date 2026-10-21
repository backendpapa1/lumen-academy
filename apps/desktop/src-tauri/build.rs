fn main() {
    // Our commands get generated permissions, so each window can be granted
    // exactly what it needs (capabilities/*.json).
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "get_setup",
            "save_setup",
            "test_key",
            "pick_folder",
            "copy_data_from",
            "open_path",
            "set_autostart",
            "open_configurator",
        ]),
    ))
    .expect("tauri build");
}
