// Lumen Academy's desktop shell (ADR-011): a Rust window around the game, the
// Node server as a sidecar, and a tray icon whose configurator holds the API
// keys and the data folder, so anyone can install it and set it up without a
// terminal or a .env file.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod keys;
mod server;
mod setup;

use std::{path::PathBuf, sync::Mutex, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_dialog::DialogExt;

use server::{ServerState, Server};

// --- the configurator's commands ----------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeyView {
    set: bool,
    hint: Option<String>,
    storage: keys::Storage,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupView {
    openai: KeyView,
    deepseek: KeyView,
    data_dir: String,
    data_has_db: bool,
    default_data_dir: String,
    autostart: bool,
    server: String,
    version: String,
    log_path: String,
}

fn key_view(name: &str) -> KeyView {
    let (v, storage) = keys::get(name);
    KeyView { set: v.is_some(), hint: v.as_deref().map(keys::hint), storage }
}

#[tauri::command]
fn get_setup(app: AppHandle) -> SetupView {
    let s = setup::load();
    SetupView {
        openai: key_view(keys::OPENAI),
        deepseek: key_view(keys::DEEPSEEK),
        data_has_db: s.data_dir.join("lumen.db").exists(),
        data_dir: s.data_dir.to_string_lossy().into_owned(),
        default_data_dir: setup::default_data_dir().to_string_lossy().into_owned(),
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
        server: app.state::<ServerState>().0.lock().unwrap().status.clone(),
        version: app.package_info().version.to_string(),
        log_path: server::log_path().to_string_lossy().into_owned(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveSetup {
    /// None: leave the saved key as it is. Some(""): remove it.
    openai: Option<String>,
    deepseek: Option<String>,
    data_dir: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    storage: keys::Storage,
}

#[tauri::command]
fn save_setup(app: AppHandle, input: SaveSetup) -> Result<Saved, String> {
    let mut storage = keys::Storage::None;
    for (name, value) in [(keys::OPENAI, &input.openai), (keys::DEEPSEEK, &input.deepseek)] {
        if let Some(v) = value {
            let s = keys::set(name, v)?;
            if s != keys::Storage::None {
                storage = s;
            }
        }
    }
    if let Some(d) = input.data_dir.filter(|d| !d.trim().is_empty()) {
        setup::save(&setup::Setup { data_dir: PathBuf::from(d.trim()) })?;
    }
    // The server reads its keys and data folder at start.
    server::start(&app);
    Ok(Saved { storage })
}

#[derive(Serialize)]
struct Tested {
    ok: bool,
    message: String,
}

/// Checks a key by listing the provider's models: a free call, no tokens.
#[tauri::command]
async fn test_key(provider: String, key: Option<String>) -> Tested {
    let name = if provider == "openai" { keys::OPENAI } else { keys::DEEPSEEK };
    let key = key.filter(|k| !k.trim().is_empty()).or_else(|| keys::get(name).0);
    let Some(key) = key else {
        return Tested { ok: false, message: "Paste a key first.".into() };
    };
    let url = if provider == "openai" {
        "https://api.openai.com/v1/models"
    } else {
        "https://api.deepseek.com/models"
    };
    let res = tauri::async_runtime::spawn_blocking(move || {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(12)))
            .build()
            .into();
        agent.get(url).header("Authorization", &format!("Bearer {}", key.trim())).call().map(|_| ())
    })
    .await;
    match res {
        Ok(Ok(())) => Tested { ok: true, message: "That key works.".into() },
        Ok(Err(ureq::Error::StatusCode(401))) | Ok(Err(ureq::Error::StatusCode(403))) => {
            Tested { ok: false, message: "The provider refused that key. Check you copied all of it.".into() }
        }
        Ok(Err(ureq::Error::StatusCode(c))) => {
            Tested { ok: false, message: format!("The provider answered {c}. Try again in a minute.") }
        }
        Ok(Err(e)) => Tested { ok: false, message: format!("Couldn't reach the provider: {e}") },
        Err(e) => Tested { ok: false, message: e.to_string() },
    }
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().set_title("Choose a folder").pick_folder(move |p| {
        let _ = tx.send(p.and_then(|p| p.into_path().ok()));
    });
    tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
        .await
        .ok()
        .flatten()
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn copy_data_from(app: AppHandle, from: String) -> Result<usize, String> {
    let to = setup::load().data_dir;
    // The copy must not race the server writing the same database.
    server::stop(&app);
    let r = setup::copy_data(&PathBuf::from(from), &to);
    server::start(&app);
    r
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    open::that(&path)
}

#[tauri::command]
fn set_autostart(app: AppHandle, on: bool) -> Result<bool, String> {
    let a = app.autolaunch();
    let r = if on { a.enable() } else { a.disable() };
    r.map_err(|e| e.to_string())?;
    sync_autostart_item(&app);
    Ok(a.is_enabled().unwrap_or(false))
}

/// From the game's Settings (a remote page, allowed this one command).
#[tauri::command]
fn open_configurator(app: AppHandle) {
    show_configurator(&app);
}

mod open {
    /// Opens a folder or file in the desktop's own app.
    pub fn that(path: &str) -> Result<(), String> {
        #[cfg(target_os = "linux")]
        let cmd = "xdg-open";
        #[cfg(target_os = "macos")]
        let cmd = "open";
        #[cfg(target_os = "windows")]
        let cmd = "explorer";
        std::process::Command::new(cmd).arg(path).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
}

// --- windows and the tray ---------------------------------------------------------

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn show_configurator(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("configurator") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "configurator", WebviewUrl::App("configurator.html".into()))
        .title("Lumen Academy: API keys and settings")
        .inner_size(600.0, 720.0)
        .min_inner_size(480.0, 560.0)
        .center()
        .build();
}

struct AutostartItem(Mutex<Option<CheckMenuItem<tauri::Wry>>>);

fn sync_autostart_item(app: &AppHandle) {
    let on = app.autolaunch().is_enabled().unwrap_or(false);
    if let Some(item) = app.state::<AutostartItem>().0.lock().unwrap().as_ref() {
        let _ = item.set_checked(on);
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Lumen Academy", true, None::<&str>)?;
    let config = MenuItem::with_id(app, "config", "API keys and settings…", true, None::<&str>)?;
    let data = MenuItem::with_id(app, "data", "Open the data folder", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "Restart the server", true, None::<&str>)?;
    let login = CheckMenuItem::with_id(
        app,
        "login",
        "Start at login",
        true,
        app.autolaunch().is_enabled().unwrap_or(false),
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit Lumen Academy", true, None::<&str>)?;
    let sep = || PredefinedMenuItem::separator(app);
    let menu = Menu::with_items(app, &[&open, &config, &sep()?, &data, &restart, &login, &sep()?, &quit])?;
    *app.state::<AutostartItem>().0.lock().unwrap() = Some(login);
    TrayIconBuilder::with_id("lumen")
        .icon(app.default_window_icon().cloned().expect("an app icon"))
        .tooltip("Lumen Academy")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "config" => show_configurator(app),
            "data" => {
                let _ = open::that(&setup::load().data_dir.to_string_lossy());
            }
            "restart" => server::start(app),
            "login" => {
                let a = app.autolaunch();
                let _ = if a.is_enabled().unwrap_or(false) { a.disable() } else { a.enable() };
                sync_autostart_item(app);
            }
            "quit" => {
                server::stop(app);
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

/// Voice teaching (V1) needs the microphone. WebKitGTK keeps media streams off
/// and asks the app about each permission: we allow the microphone and camera
/// request for our own server's page only, and refuse everything else.
#[cfg(target_os = "linux")]
fn allow_microphone(w: &tauri::WebviewWindow) {
    let _ = w.with_webview(|wv| {
        use webkit2gtk::{glib::object::Cast, PermissionRequestExt, SettingsExt, UserMediaPermissionRequest, WebViewExt};
        let view = wv.inner();
        if let Some(settings) = WebViewExt::settings(&view) {
            settings.set_enable_media_stream(true);
            settings.set_enable_webaudio(true);
            settings.set_media_playback_requires_user_gesture(false);
        }
        view.connect_permission_request(|view, req| {
            let ours = view.uri().map(|u| u.starts_with("http://127.0.0.1:")).unwrap_or(false);
            if ours && req.clone().downcast::<UserMediaPermissionRequest>().is_ok() {
                req.allow();
            } else {
                req.deny();
            }
            true
        });
    });
}
#[cfg(not(target_os = "linux"))]
fn allow_microphone(_w: &tauri::WebviewWindow) {}

fn main() {
    tauri::Builder::default()
        // A second launch just brings the open window forward.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .manage(ServerState(Mutex::new(Server::default())))
        .manage(audio::Audio::new())
        .manage(AutostartItem(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            get_setup,
            save_setup,
            test_key,
            pick_folder,
            copy_data_from,
            open_path,
            set_autostart,
            open_configurator,
            audio::audio_play,
            audio::audio_stop,
            audio::audio_volume
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let main = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Lumen Academy")
                .inner_size(1440.0, 900.0)
                .min_inner_size(960.0, 640.0)
                .center()
                .build()?;
            allow_microphone(&main);
            build_tray(&handle)?;
            // A fresh install: the keys come first.
            if keys::env().len() < keys::ALL.len() {
                show_configurator(&handle);
            }
            server::start(&handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Lumen Academy failed to start")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                server::stop(app);
            }
        });
}
