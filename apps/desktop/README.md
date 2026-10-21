# Lumen Academy desktop app

A Rust (Tauri 2) shell around the game. The Node server runs beside it, and a tray icon opens the configurator for the API keys and the data folder.

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

## Android

The same Tauri project builds an Android app for arm64 phones on Android 10 or newer. The whole of Lumen runs on the phone: its Node server runs inside the app, and the game opens in the app's window. Classes still run online on DeepSeek, and indexing and pictures on OpenAI.

**Installing it:** copy the `.apk` to the phone and open it, or connect the phone over USB and run `adb install -r <the apk>`. Some phones (Xiaomi, for one) ask you to tap **Install** on the phone, and need "Install via USB" switched on in the developer options.

**First launch:**

1. Lumen unpacks itself, which takes a little while, once.
2. The keys page opens. Paste each key, test it, then save.
3. The game opens on the campus.

On the phone:

- Your keys are encrypted with a key kept in the Android Keystore.
- Your data lives inside the app. Use a School's export and import to move it between devices.
- Students speak with the phone's own voices (Android's text-to-speech).
- Hold-to-talk uses the phone's speech recogniser. It asks for the microphone the first time.
- A quiet notification shows while Lumen runs. Swiping the app away stops it, unless a class or a curriculum build is still going.

**Building it:**

```bash
rustup target add aarch64-linux-android
export ANDROID_HOME=~/Android/Sdk NDK_HOME=~/Android/Sdk/ndk/<version> JAVA_HOME=<a JDK 17>
pnpm --filter @lumen/desktop android:debug   # a debug APK
pnpm --filter @lumen/desktop android:build   # a signed release APK
```

The APKs land in `src-tauri/gen/android/app/build/outputs/apk/arm64/{debug,release}/`.

`android:bundle` (`scripts/bundle-android.mjs`) builds what the app carries beside its Rust and Kotlin code:

- In `jniLibs/arm64-v8a/`:
  - `libld.so`, glibc's loader;
  - `libsigsys.so`, a small supervisor built from `android/sigsys.c` with the NDK.
- `assets/lumen-runtime.tar.xz`, which holds:
  - Node for linux-arm64 and Debian's glibc, both checked against their published hashes;
  - the server bundle with arm64 natives, without Kokoro.

Release signing reads `src-tauri/gen/android/keystore.properties` (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`), else `~/.config/lumen-android/keystore.properties`, or the `LUMEN_KEYSTORE`, `LUMEN_KEYSTORE_PASSWORD`, `LUMEN_KEY_ALIAS` and `LUMEN_KEY_PASSWORD` variables. Keep the keystore outside the repo, and use the same one for every release: Android installs an update only when it's signed with the same key.
