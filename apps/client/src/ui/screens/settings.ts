import { api, ApiError, type Settings } from "../../core/api";
import { app } from "../../core/app";
import { sound } from "../../core/audio";
import { h } from "./dom";
import { openModal } from "./modal";

// Settings (O-1): model profile, monthly and image budgets, period length.
// Saved on the server and applied at once, no restart.

export function openSettings() {
  const body = h("div", {}, h("p", { class: "dim" }, "Loading…"));
  const close = openModal("Settings", body);
  api
    .get<Settings>("/api/settings")
    .then((s) => body.replaceChildren(form(s, close)))
    .catch((e: Error) => body.replaceChildren(h("p", { class: "error-text" }, e.message)));
}

function form(s: Settings, close: () => void): HTMLElement {
  const profile = h(
    "select",
    { class: "field", id: "set-profile" },
    ...s.profiles.map((p) => h("option", { value: p, selected: p === s.profile }, p)),
  );
  const cap = h("input", {
    class: "field",
    id: "set-cap",
    type: "number",
    min: 1,
    max: 500,
    step: 1,
    value: s.monthlyUsdCap,
  });
  const images = h("input", {
    class: "field",
    id: "set-images",
    type: "number",
    min: 0,
    max: 500,
    step: 0.5,
    value: s.imagesUsdCap,
  });
  const minutes = h("input", {
    class: "field",
    id: "set-minutes",
    type: "number",
    min: s.minMinutes,
    max: s.maxMinutes,
    step: 1,
    value: s.periodMinutes,
  });
  const err = h("p", { class: "error-text", role: "alert" });
  const save = h("button", { class: "btn primary", type: "submit" }, "Save settings");
  const keys = h(
    "p",
    { class: "dim", style: "font-size:13px;margin-top:16px" },
    `API keys (in .env on this machine): DeepSeek ${s.hasDeepSeekKey ? "set" : "missing"} · OpenAI ${s.hasOpenAiKey ? "set" : "missing"}.`,
  );
  const f = h(
    "form",
    {},
    h("label", { class: "lbl", for: "set-profile" }, "Model profile"),
    profile,
    h(
      "div",
      { class: "two-col" },
      h("div", {}, h("label", { class: "lbl", for: "set-cap" }, "Monthly budget (USD)"), cap),
      h(
        "div",
        {},
        h("label", { class: "lbl", for: "set-images" }, "Of which images (USD)"),
        images,
      ),
    ),
    h(
      "label",
      { class: "lbl", for: "set-minutes" },
      `Class period (${s.minMinutes}–${s.maxMinutes} minutes)`,
    ),
    minutes,
    h(
      "label",
      { class: "row", style: "gap:8px;margin-top:14px;font-size:14px" },
      (() => {
        const box = h("input", { type: "checkbox", checked: !sound.muted });
        box.addEventListener("change", () => {
          if (box.checked === sound.muted) sound.toggleMute();
        });
        return box;
      })(),
      "Sound (ambient pads and cues; M toggles anywhere)",
    ),
    keys,
    err,
    h(
      "div",
      { class: "actions" },
      h("button", { class: "btn quiet", type: "button", onclick: () => close() }, "Cancel"),
      save,
    ),
  );
  f.addEventListener("submit", (e) => {
    e.preventDefault();
    save.disabled = true;
    api
      .put<Settings>("/api/settings", {
        profile: profile.value,
        monthlyUsdCap: Number(cap.value),
        imagesUsdCap: Number(images.value),
        periodMinutes: Number(minutes.value),
      })
      .then(() => {
        close();
        app.notify("Settings saved.");
      })
      .catch((e: unknown) => {
        err.textContent = e instanceof ApiError ? e.message : String(e);
        save.disabled = false;
      });
  });
  return f;
}
