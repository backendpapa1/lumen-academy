//! The API keys (ADR-011). They live in the OS keyring (GNOME Keyring / KWallet
//! through the Secret Service on Linux), and reach the Node server only as
//! environment variables when it starts. The game window never sees them.
//! Without a keyring (some minimal desktops) they fall back to a file only this
//! user can read, and the configurator says so.

use std::{fs, path::PathBuf};

use serde::Serialize;

const SERVICE: &str = "academy.lumen.app";

/// The env var names the server reads (config/models.yaml `apiKeyEnv`).
pub const OPENAI: &str = "OPENAI_API_KEY";
pub const DEEPSEEK: &str = "DEEPSEEK_API_KEY";
pub const ALL: [&str; 2] = [OPENAI, DEEPSEEK];

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Storage {
    Keyring,
    File,
    None,
}

fn fallback_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join(SERVICE).join("keys.json"))
}

fn read_fallback() -> serde_json::Map<String, serde_json::Value> {
    fallback_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_fallback(map: &serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    let path = fallback_path().ok_or("no config folder")?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(&path, serde_json::to_string_pretty(map).unwrap()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// A key and where it came from.
pub fn get(name: &str) -> (Option<String>, Storage) {
    if let Ok(entry) = keyring::Entry::new(SERVICE, name) {
        if let Ok(v) = entry.get_password() {
            if !v.is_empty() {
                return (Some(v), Storage::Keyring);
            }
        }
    }
    match read_fallback().get(name).and_then(|v| v.as_str()) {
        Some(v) if !v.is_empty() => (Some(v.to_string()), Storage::File),
        _ => (None, Storage::None),
    }
}

/// Saves a key (an empty one removes it). Returns where it went.
pub fn set(name: &str, value: &str) -> Result<Storage, String> {
    let value = value.trim();
    let mut file = read_fallback();
    if value.is_empty() {
        if let Ok(entry) = keyring::Entry::new(SERVICE, name) {
            let _ = entry.delete_credential();
        }
        if file.remove(name).is_some() {
            write_fallback(&file)?;
        }
        return Ok(Storage::None);
    }
    let in_keyring = keyring::Entry::new(SERVICE, name)
        .and_then(|e| e.set_password(value))
        .is_ok();
    if in_keyring {
        // Never leave an older copy in the file once the keyring has it.
        if file.remove(name).is_some() {
            write_fallback(&file)?;
        }
        return Ok(Storage::Keyring);
    }
    file.insert(name.to_string(), serde_json::Value::String(value.to_string()));
    write_fallback(&file)?;
    Ok(Storage::File)
}

/// The keys that are set, for the server's environment.
pub fn env() -> Vec<(&'static str, String)> {
    ALL.iter()
        .filter_map(|n| get(n).0.map(|v| (*n, v)))
        .collect()
}

/// "sk-…a1b2": enough to recognise a key, never enough to use it.
pub fn hint(value: &str) -> String {
    let tail: String = value.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    let head: String = value.chars().take(3).collect();
    format!("{head}…{tail}")
}
