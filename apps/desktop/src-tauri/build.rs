fn main() {
    // Our commands get generated permissions, so each window can be granted
    // exactly what it needs (capabilities/*.json).
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&[
                "get_setup",
                "save_setup",
                "test_key",
                "pick_folder",
                "copy_data_from",
                "open_path",
                "set_autostart",
                "open_configurator",
                "audio_play",
                "audio_stop",
                "audio_volume",
            ]))
            // Android (ADR-012): the Kotlin plugin's commands the pages may call:
            // speech for the game, and leaving the configurator for the game.
            .plugin(
                "lumen",
                tauri_build::InlinedPlugin::new().commands(&[
                    "speak",
                    "stop_speaking",
                    "voices",
                    "listen_start",
                    "listen_stop",
                    "open_game",
                ]),
            ),
    )
    .expect("tauri build");
}
