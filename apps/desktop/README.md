# Lumen Academy desktop app

A Rust (Tauri 2) shell around the game. The Node server runs beside it, and a tray icon opens the configurator for the API keys and the data folder. See `docs/decisions/ADR-011-desktop-shell.md`.

## Installing it (for anyone)

You'll need a **DeepSeek API key** (it runs your students) and an **OpenAI API key** (it reads your sources and draws the school's pictures). Both are pay-as-you-go. Lumen shows what each class cost, and you can set monthly caps in the game's Settings.

**Ubuntu, Debian, Mint, Pop!_OS:**

1. Double-click `Lumen Academy_0.8.0_amd64.deb` and choose Install, or run `sudo apt install ./Lumen\ Academy_0.8.0_amd64.deb`.
2. Open **Lumen Academy** from your applications.

**Any other Linux (AppImage):**

1. Download `Lumen Academy_0.8.0_amd64.AppImage`.
2. Right-click it → Properties → Permissions → "Allow executing as program", or run `chmod +x "Lumen Academy_0.8.0_amd64.AppImage"`.
3. Double-click it.

**First launch:** the configurator opens by itself.
1. Paste each key and press **Test the key**.
2. Press **Save and restart Lumen**.

The game then opens on the campus, and Ms Hale's guided tour shows you around.

Your keys are stored in the system keyring. To change them later, use the tray icon → **API keys and settings…**, or the game's Settings → "API keys and data folder…".

Your data lives in `~/Lumen` (Schools, students, transcripts, your sources), unless you choose another folder in the configurator. Back that folder up like any other.

**Voice:**
- Students' voices download a speech model the first time they speak, which needs the internet once.
- Speaking to the class needs Whisper (`whisper.cpp`) on the machine. Without it, the app says so and you type instead.

## Building it

```bash
pnpm i
pnpm --filter @lumen/desktop package    # bundles the server, then `tauri build`
```

The packages land in `apps/desktop/src-tauri/target/release/bundle/{deb,appimage}/`.

- `pnpm --filter @lumen/desktop server:bundle` rebuilds `build/server/` (the client, the bundled server, production `node_modules`, config, migrations, prompts) and copies this machine's Node into `src-tauri/binaries/` as the sidecar.
- `node apps/desktop/scripts/bundle-server.mjs --js` rebuilds only the client and `server.mjs`, for quick changes.
- `cd apps/desktop/src-tauri && cargo build` gives a debug build at `target/debug/lumen-academy`.

Linux build needs: `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev patchelf`, plus Rust.
