//! The Android shell (ADR-012). The work is in Kotlin (gen/android/app/src/main/
//! java/academy/lumen/app/): LumenPlugin runs the Node server inside the app,
//! holds the keys in the Android Keystore, keeps a foreground service while
//! there's work, and speaks and listens with Android's own TextToSpeech and
//! SpeechRecognizer. Here we only open the window and register that plugin,
//! and give the configurator the same commands it has on the desktop.

use serde_json::{json, Value};
use tauri::{
    plugin::{Builder as PluginBuilder, PluginHandle, TauriPlugin},
    AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, Wry,
};

struct Lumen(PluginHandle<Wry>);

/// "lumen": its commands are implemented in Kotlin (LumenPlugin.kt). Those the
/// game page may call are listed in build.rs and granted in capabilities/.
fn lumen_plugin() -> TauriPlugin<Wry> {
    PluginBuilder::new("lumen")
        .setup(|app, api| {
            let handle = api.register_android_plugin("academy.lumen.app", "LumenPlugin")?;
            app.manage(Lumen(handle));
            Ok(())
        })
        .build()
}

async fn kotlin(app: &AppHandle, command: &str, args: Value) -> Result<Value, String> {
    app.state::<Lumen>()
        .0
        .run_mobile_plugin_async::<Value>(command, args)
        .await
        .map_err(|e| e.to_string())
}

// The configurator's commands, as on the desktop (desktop.rs), answered by Kotlin.

#[tauri::command]
async fn get_setup(app: AppHandle) -> Result<Value, String> {
    kotlin(&app, "getSetup", json!({})).await
}

#[tauri::command]
async fn save_setup(app: AppHandle, input: Value) -> Result<Value, String> {
    kotlin(&app, "saveSetup", input).await
}

#[tauri::command]
async fn test_key(app: AppHandle, provider: String, key: Option<String>) -> Result<Value, String> {
    kotlin(&app, "testKey", json!({ "provider": provider, "key": key })).await
}

#[tauri::command]
async fn open_configurator(app: AppHandle) -> Result<Value, String> {
    kotlin(&app, "openConfigurator", json!({})).await
}

#[tauri::command]
async fn open_path(app: AppHandle, path: String) -> Result<Value, String> {
    kotlin(&app, "openUrl", json!({ "url": path })).await
}

pub fn run() {
    tauri::Builder::default()
        .plugin(lumen_plugin())
        .invoke_handler(tauri::generate_handler![
            get_setup,
            save_setup,
            test_key,
            open_configurator,
            open_path
        ])
        .setup(|app| {
            // The loading page; LumenPlugin moves it to the game once the server answers.
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into())).build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Lumen Academy failed to start");
}
