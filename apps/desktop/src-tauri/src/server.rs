//! The Node server as a sidecar (ADR-011): the bundled Node 24 runs the bundled
//! server on a free port on 127.0.0.1, with the keys in its environment. When
//! /api/health answers, the main window moves from the loading page to the game.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    net::TcpListener,
    path::PathBuf,
    sync::Mutex,
    time::Duration,
};

use tauri::{AppHandle, Manager, Url};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

use crate::{keys, setup};

#[derive(Default)]
pub struct Server {
    child: Option<CommandChild>,
    pub port: u16,
    /// "starting", "running", or what went wrong.
    pub status: String,
    /// Bumped on every start, so a stale health check never navigates.
    generation: u64,
}

pub struct ServerState(pub Mutex<Server>);

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(47474)
}

pub fn log_path() -> PathBuf {
    dirs::state_dir()
        .or_else(dirs::data_local_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join("academy.lumen.app")
        .join("server.log")
}

fn log(line: &[u8]) {
    let p = log_path();
    let _ = fs::create_dir_all(p.parent().unwrap());
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(p) {
        let _ = f.write_all(line);
        if !line.ends_with(b"\n") {
            let _ = f.write_all(b"\n");
        }
    }
}

/// Starts (or restarts) the server and points the main window at it.
pub fn start(app: &AppHandle) {
    let state = app.state::<ServerState>();
    let port = free_port();
    // A new generation first, so the old server's exit isn't taken for a crash.
    let (generation, old) = {
        let mut s = state.0.lock().unwrap();
        s.generation += 1;
        s.port = port;
        s.status = "starting".into();
        (s.generation, s.child.take())
    };
    if let Some(c) = old {
        let _ = c.kill();
    }
    // Rotate the log on each start: it's for the last session only.
    let _ = fs::remove_file(log_path());

    let res = match app.path().resource_dir() {
        Ok(d) => d.join("server"),
        Err(e) => return fail(app, generation, &format!("No resources folder: {e}")),
    };
    let data = setup::load().data_dir;
    if let Err(e) = fs::create_dir_all(&data) {
        return fail(app, generation, &format!("Can't create the data folder {}: {e}", data.display()));
    }
    let p = |sub: &str| res.join(sub).to_string_lossy().into_owned();
    let mut cmd = match app.shell().sidecar("lumen-node") {
        Ok(c) => c,
        Err(e) => return fail(app, generation, &format!("The bundled Node is missing: {e}")),
    };
    // The environment we were launched with, minus any API keys from the shell:
    // only the keys saved in the configurator count.
    let inherited: Vec<(String, String)> = std::env::vars()
        .filter(|(k, _)| !keys::ALL.contains(&k.as_str()))
        .collect();
    cmd = cmd
        .env_clear()
        .envs(inherited)
        .arg(p("server.mjs"))
        .current_dir(&data)
        .env("LUMEN_DESKTOP", "1")
        .env("LUMEN_PORT", port.to_string())
        .env("LUMEN_DATA_DIR", data.to_string_lossy().into_owned())
        .env("LUMEN_CONFIG_DIR", p("config"))
        .env("LUMEN_MIGRATIONS_DIR", p("drizzle"))
        .env("LUMEN_PROMPTS_DIR", p("prompts"))
        .env("LUMEN_CLIENT_DIR", p("client"));
    for (name, value) in keys::env() {
        cmd = cmd.env(name, value);
    }
    let (mut rx, child) = match cmd.spawn() {
        Ok(x) => x,
        Err(e) => return fail(app, generation, &format!("The server didn't start: {e}")),
    };
    state.0.lock().unwrap().child = Some(child);

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            match ev {
                CommandEvent::Stdout(l) | CommandEvent::Stderr(l) => log(&l),
                CommandEvent::Terminated(t) => {
                    log(format!("server exited: {t:?}").as_bytes());
                    let current = handle.state::<ServerState>().0.lock().unwrap().generation;
                    if current == generation {
                        fail(&handle, generation, "The server stopped. The log has the details.");
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    let handle = app.clone();
    std::thread::spawn(move || {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(2)))
            .build()
            .into();
        let url = format!("http://127.0.0.1:{port}/api/health");
        for _ in 0..240 {
            if handle.state::<ServerState>().0.lock().unwrap().generation != generation {
                return;
            }
            if agent.get(&url).call().is_ok() {
                handle.state::<ServerState>().0.lock().unwrap().status = "running".into();
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.navigate(Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap());
                }
                return;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        fail(&handle, generation, "The server took too long to start. The log has the details.");
    });
}

/// Shows what went wrong on the loading page (it stays local, so it can).
fn fail(app: &AppHandle, generation: u64, msg: &str) {
    log(format!("error: {msg}").as_bytes());
    let state = app.state::<ServerState>();
    {
        let mut s = state.0.lock().unwrap();
        if s.generation != generation {
            return;
        }
        s.status = msg.to_string();
    }
    if let Some(w) = app.get_webview_window("main") {
        let local = w.url().map(|u| u.scheme() == "tauri" || u.host_str() == Some("tauri.localhost")).unwrap_or(true);
        if !local {
            let _ = w.navigate(Url::parse("tauri://localhost/index.html").unwrap());
            std::thread::sleep(Duration::from_millis(400));
        }
        let _ = w.eval(format!("window.lumenFailed && window.lumenFailed({})", serde_json::to_string(msg).unwrap()));
    }
}

pub fn stop(app: &AppHandle) {
    let state = app.state::<ServerState>();
    let child = state.0.lock().unwrap().child.take();
    if let Some(c) = child {
        let _ = c.kill();
    }
}
