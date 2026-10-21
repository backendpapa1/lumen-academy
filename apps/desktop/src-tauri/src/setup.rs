//! Where Lumen keeps its data, chosen in the configurator. Defaults to ~/Lumen
//! so it's easy to find and back up.

use std::{fs, path::PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Setup {
    pub data_dir: PathBuf,
}

fn path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("academy.lumen.app").join("setup.json"))
}

pub fn default_data_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join("Lumen")
}

pub fn load() -> Setup {
    path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| Setup { data_dir: default_data_dir() })
}

pub fn save(s: &Setup) -> Result<(), String> {
    let p = path().ok_or("no config folder")?;
    fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(p, serde_json::to_string_pretty(s).unwrap()).map_err(|e| e.to_string())
}

/// Copies another Lumen data folder in (the database, uploads, generated
/// images), only into a folder that has no database yet. Returns files copied.
pub fn copy_data(from: &PathBuf, to: &PathBuf) -> Result<usize, String> {
    if !from.join("lumen.db").exists() {
        return Err("That folder has no lumen.db in it.".into());
    }
    if to.join("lumen.db").exists() {
        return Err("This data folder already has a database. Choose an empty folder to copy into.".into());
    }
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    let mut n = 0;
    for f in ["lumen.db", "lumen.db-wal", "lumen.db-shm"] {
        if from.join(f).exists() {
            fs::copy(from.join(f), to.join(f)).map_err(|e| e.to_string())?;
            n += 1;
        }
    }
    for d in ["uploads", "generated"] {
        if from.join(d).is_dir() {
            n += copy_dir(&from.join(d), &to.join(d))?;
        }
    }
    Ok(n)
}

fn copy_dir(from: &PathBuf, to: &PathBuf) -> Result<usize, String> {
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    let mut n = 0;
    for entry in fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        if p.is_dir() {
            n += copy_dir(&p, &to.join(entry.file_name()))?;
        } else if p.is_file() {
            fs::copy(&p, to.join(entry.file_name())).map_err(|e| e.to_string())?;
            n += 1;
        }
    }
    Ok(n)
}
