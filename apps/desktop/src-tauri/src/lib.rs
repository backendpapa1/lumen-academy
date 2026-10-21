//! Lumen Academy's shell, one crate for the desktop (ADR-011) and Android
//! (ADR-012). The desktop runs the Node server as a Tauri sidecar and keeps
//! the keys in the OS keyring; Android runs it inside the app through a glibc
//! loader and keeps the keys in the Android Keystore (src/mobile.rs and the
//! Kotlin side in gen/android).

#[cfg(desktop)]
mod audio;
#[cfg(desktop)]
mod desktop;
#[cfg(desktop)]
mod keys;
#[cfg(desktop)]
mod server;
#[cfg(desktop)]
mod setup;

#[cfg(mobile)]
mod mobile;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(desktop)]
    desktop::run();
    #[cfg(mobile)]
    mobile::run();
}
