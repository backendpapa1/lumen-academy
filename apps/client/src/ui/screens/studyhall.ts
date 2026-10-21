import { app } from "../../core/app";
import { sound } from "../../core/audio";
import { store } from "../../core/store";
import { lookFor, peepSvg, type Pose } from "../peeps/peep";
import { fill, h, icon, ICONS } from "./dom";
import { parkingLot } from "./parkingLot";
import "./studyhall.css";

// Study hall (V3-06): body doubling. A quiet drawn person works at the next
// desk (writes, reads, sips, turns a page) while I prepare notes or read my
// sources. No AI, just presence, a calm timer and my parking lot.

const COMPANION = lookFor("cdt_study_companion", "short");
/** What the companion is doing, and roughly for how long (seconds). */
const ACTS: Array<{ act: "write" | "read" | "sip" | "page"; pose: Pose; secs: [number, number] }> =
  [
    { act: "write", pose: "notes", secs: [24, 48] },
    { act: "read", pose: "idle", secs: [20, 40] },
    { act: "sip", pose: "idle", secs: [5, 7] },
    { act: "page", pose: "idle", secs: [3, 4] },
  ];
const PRESETS = [15, 25, 45];

export function mountStudyHall(root: HTMLElement, schoolId?: string): () => void {
  root.classList.add("studyhall");
  const schools = store.getState().setup.schools ?? [];
  let school = schoolId ?? schools[0]?.id;

  // --- the scene: a lamp-lit desk by a rainy window ---------------------------
  const person = h("div", { class: "sh-person", "aria-hidden": "true" });
  const scene = h(
    "div",
    { class: "sh-scene", role: "img", "aria-label": "A study companion working at the next desk" },
    h("div", { class: "sh-window" }, h("div", { class: "sh-rain" })),
    h("div", { class: "sh-shelf" }, h("i"), h("i")),
    h("div", { class: "sh-lamp" }, h("i", { class: "shade" }), h("i", { class: "glow" })),
    person,
    h(
      "div",
      { class: "sh-desk" },
      h("div", { class: "sh-book" }, h("i", { class: "page" })),
      h("div", { class: "sh-notes" }),
      h("div", { class: "sh-mug" }),
    ),
  );
  let act = ACTS[1]!;
  let actTimer: ReturnType<typeof setTimeout> | undefined;
  const nextAct = () => {
    // Mostly writing and reading; a sip or a page turn now and then.
    const r = Math.random();
    const prev = act.act;
    act = r < 0.42 ? ACTS[0]! : r < 0.8 ? ACTS[1]! : r < 0.9 ? ACTS[2]! : ACTS[3]!;
    if (act.act === prev && act.act !== "write" && act.act !== "read") act = ACTS[1]!;
    person.innerHTML = peepSvg(COMPANION, {
      pose: act.pose,
      face: act.act === "sip" ? "Smile" : "Calm",
    });
    scene.dataset.act = act.act;
    const [lo, hi] = act.secs;
    actTimer = setTimeout(nextAct, (lo + Math.random() * (hi - lo)) * 1000);
  };
  nextAct();

  // --- the calm timer ---------------------------------------------------------
  let minutes = 25;
  let endsAt: number | null = null;
  let leftMs = minutes * 60_000;
  const digits = h("div", { class: "sh-digits", role: "timer", "aria-live": "off" });
  const startBtn = h("button", { class: "btn primary" });
  const presetRow = h("div", { class: "seg", role: "group", "aria-label": "Minutes" });
  const show = () => {
    const ms = endsAt ? Math.max(0, endsAt - Date.now()) : leftMs;
    const s = Math.ceil(ms / 1000);
    digits.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    fill(
      startBtn,
      icon(ICONS.play),
      endsAt ? "Pause" : leftMs < minutes * 60_000 ? "Carry on" : "Start",
    );
    for (const b of presetRow.querySelectorAll("button"))
      b.setAttribute("aria-pressed", String(Number(b.dataset.min) === minutes));
    if (endsAt && ms <= 0) {
      endsAt = null;
      leftMs = minutes * 60_000;
      sound.cue("bell");
      app.notify(`That's ${minutes} minutes. Nicely done. Stretch, then go again or teach it.`);
      show();
    }
  };
  startBtn.addEventListener("click", () => {
    if (endsAt) {
      leftMs = Math.max(0, endsAt - Date.now());
      endsAt = null;
    } else endsAt = Date.now() + leftMs;
    show();
  });
  for (const m of PRESETS)
    presetRow.append(
      h(
        "button",
        {
          "data-min": m,
          onclick: () => {
            minutes = m;
            leftMs = m * 60_000;
            endsAt = null;
            show();
          },
        },
        `${m} min`,
      ),
    );
  const tick = setInterval(show, 250);
  show();

  // --- the side panel: timer, then the School's parking lot -------------------
  const lotSlot = h("div");
  const renderLot = () =>
    fill(
      lotSlot,
      school
        ? parkingLot(school, { add: true, title: "Parking lot" })
        : h("p", { class: "dim small" }, "Found a School to keep a parking lot here."),
    );
  const picker =
    schools.length > 1
      ? h(
          "select",
          {
            class: "field",
            "aria-label": "School",
            onchange: (e: Event) => {
              school = (e.target as HTMLSelectElement).value;
              renderLot();
            },
          },
          ...schools.map((s) => h("option", { value: s.id, selected: s.id === school }, s.name)),
        )
      : null;
  renderLot();

  root.append(
    h(
      "div",
      { class: "sh-wrap" },
      h(
        "header",
        { class: "sh-top" },
        h(
          "button",
          { class: "btn quiet", onclick: () => app.backToBoot() },
          icon(ICONS.back),
          "Campus",
        ),
        h(
          "div",
          {},
          h("div", { class: "micro" }, "Lumen Academy"),
          h("h1", { class: "display" }, "Study hall"),
        ),
      ),
      h(
        "div",
        { class: "sh-grid" },
        scene,
        h(
          "aside",
          { class: "sh-side" },
          h(
            "section",
            { class: "card pad sh-timer", "aria-label": "Timer" },
            h("div", { class: "micro" }, "Work alongside"),
            digits,
            presetRow,
            h("div", { class: "row", style: "margin-top:12px" }, startBtn),
            h(
              "p",
              { class: "dim small", style: "margin:12px 0 0" },
              "Read a source, sketch tomorrow's lesson, write notes. They'll keep you company.",
            ),
          ),
          picker,
          lotSlot,
        ),
      ),
    ),
  );
  queueMicrotask(() => startBtn.focus({ preventScroll: true }));

  return () => {
    clearInterval(tick);
    clearTimeout(actTimer);
    root.classList.remove("studyhall");
  };
}
