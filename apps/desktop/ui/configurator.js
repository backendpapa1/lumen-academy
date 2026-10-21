// The configurator (ADR-011): API keys, the data folder and launch at login.
// Everything goes through the Rust commands; keys are only ever sent there,
// and only shown back as a hint ("sk-…a1b2").
const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
const say = (msg, bad = false) => {
  $("status").textContent = msg;
  $("status").classList.toggle("bad", bad);
};

let setup = null;
let pendingDataDir = null;

function paintKey(provider) {
  const card = document.querySelector(`.key[data-provider="${provider}"]`);
  const k = setup[provider];
  const chip = card.querySelector(".chip");
  chip.className = `chip ${k.set ? "ok" : "missing"}`;
  chip.textContent = k.set ? `Saved ${k.hint}` : "Not set";
  card.querySelector("input").placeholder = k.set ? "Leave empty to keep the saved key" : "sk-…";
}

function paintData() {
  $("dataDir").textContent = pendingDataDir ?? setup.dataDir;
  $("dataNote").textContent = pendingDataDir
    ? "Save to switch to this folder."
    : setup.dataHasDb
      ? "Your Lumen database is here."
      : "Empty for now: your first School will be saved here.";
}

async function load() {
  setup = await invoke("get_setup");
  paintKey("deepseek");
  paintKey("openai");
  paintData();
  $("autostart").checked = setup.autostart;
  $("fileWarn").hidden = ![setup.openai.storage, setup.deepseek.storage].includes("file");
  $("version").textContent = `Version ${setup.version} · server: ${setup.server || "not started"}`;
  if (!setup.deepseek.set || !setup.openai.set)
    say("Add both keys to teach a class: paste them below, test, then save.");
}

for (const card of document.querySelectorAll(".key")) {
  const provider = card.dataset.provider;
  const input = card.querySelector("input");
  const result = card.querySelector(".result");
  card.querySelector(".reveal").onclick = (e) => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    e.currentTarget.textContent = show ? "Hide" : "Show";
  };
  card.querySelector(".test").onclick = async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    result.className = "result small";
    result.textContent = "Checking with the provider…";
    const r = await invoke("test_key", { provider, key: input.value || null });
    result.className = `result small ${r.ok ? "ok" : "bad"}`;
    result.textContent = r.ok ? `✓ ${r.message}` : r.message;
    b.disabled = false;
  };
  card.querySelector(".link").onclick = (e) => {
    e.preventDefault();
    invoke("open_path", { path: e.currentTarget.href });
  };
}

$("chooseData").onclick = async () => {
  const p = await invoke("pick_folder");
  if (p) {
    pendingDataDir = p;
    paintData();
  }
};
$("copyData").onclick = async () => {
  if (pendingDataDir) return say("Save the new data folder first, then copy into it.", true);
  const from = await invoke("pick_folder");
  if (!from) return;
  say("Copying…");
  try {
    const n = await invoke("copy_data_from", { from });
    say(`Copied ${n} files. Lumen restarted with them.`);
    await load();
  } catch (e) {
    say(String(e), true);
  }
};
$("openData").onclick = () => invoke("open_path", { path: pendingDataDir ?? setup.dataDir });
$("autostart").onchange = async (e) => {
  try {
    e.target.checked = await invoke("set_autostart", { on: e.target.checked });
  } catch (err) {
    say(`Couldn't change that: ${err}`, true);
  }
};
$("close").onclick = () => window.__TAURI__.window.getCurrentWindow().close();
$("save").onclick = async (e) => {
  const b = e.currentTarget;
  b.disabled = true;
  say("Saving…");
  try {
    const input = {
      deepseek: $("deepseek").value.trim() || null,
      openai: $("openai").value.trim() || null,
      dataDir: pendingDataDir,
    };
    const r = await invoke("save_setup", { input });
    $("deepseek").value = "";
    $("openai").value = "";
    pendingDataDir = null;
    await load();
    say(
      r.storage === "file"
        ? "Saved (in a private file: no keyring answered). Lumen is restarting."
        : "Saved. Lumen is restarting with your settings.",
    );
  } catch (err) {
    say(String(err), true);
  }
  b.disabled = false;
};

load().catch((e) => say(String(e), true));
