// The desktop entry point; the app itself is in lib.rs (shared with Android).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    lumen_academy_lib::run();
}
