import { api, ApiError } from "../../core/api";
import { app } from "../../core/app";
import { sound, type StudyAmbience } from "../../core/audio";
import { store } from "../../core/store";
import { lookFor, peepSvg, type Pose } from "../peeps/peep";
import { fill, h, icon, ICONS } from "./dom";
import { parkingLot } from "./parkingLot";
import { studyBuddy } from "./studyBuddy";
import { prepPanel } from "./studyPrep";
import { mountReader, type Reader } from "./studyReader";
import { studyTimer } from "./studyTimer";
import type { Classmate, StudyData } from "./studyTypes";
import "./studyhall.css";

// Study hall (V3-06, Paul's notes): a study session with company, that gets me
// ready to teach. A quiet drawn person works at the next desk, and students
// from my own class do their homework at the desks behind (body doubling: no
// AI, just presence). I read my sources a chapter at a time, prepare the
// concept each class meets next, look up what I couldn't answer, and now and
// then a student leans over with a question. A focus timer with an intention,
// a real break, and minutes that keep the streak.

const COMPANION = lookFor("cdt_study_companion", "short", "male");
/** What the companion is doing, and roughly for how long (seconds). */
const ACTS: Array<{ act: "write" | "read" | "sip" | "page"; pose: Pose; secs: [number, number] }> =
  [
    { act: "write", pose: "notes", secs: [24, 48] },
    { act: "read", pose: "idle", secs: [20, 40] },
    { act: "sip", pose: "idle", secs: [5, 7] },
    { act: "page", pose: "idle", secs: [3, 4] },
  ];
const AMBIENCES: Array<[StudyAmbience, string]> = [
  ["rain", "Rain"],
  ["cafe", "Café"],
  ["library", "Library"],
  ["quiet", "Quiet"],
];
const TAB_KEY = "lumen.studyTab";
type Tab = "prep" | "notes" | "lot";

export function mountStudyHall(
  root: HTMLElement,
  schoolId?: string,
  conceptId?: string,
): () => void {
  root.classList.add("studyhall");
  const schools = store.getState().setup.schools ?? [];
  let school = schoolId ?? schools[0]?.id;
  let data: StudyData | null = null;
  let resting = false;

  // --- the scene: a lamp-lit desk by a window; my class at the desks behind --------
  const person = h("div", { class: "sh-person", "aria-hidden": "true" });
  const mates = h("div", { class: "sh-mates", "aria-hidden": "true" });
  const scene = h(
    "div",
    { class: "sh-scene", role: "img", "aria-label": "A study companion working at the next desk" },
    h("div", { class: "sh-window" }, h("div", { class: "sh-rain" })),
    h("div", { class: "sh-shelf" }, h("i"), h("i")),
    mates,
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
  const draw = () => {
    person.innerHTML = peepSvg(COMPANION, {
      pose: resting ? "arms" : act.pose,
      face: resting || act.act === "sip" ? "Smile" : "Calm",
    });
    scene.dataset.act = resting ? "stretch" : act.act;
  };
  const nextAct = () => {
    // Mostly writing and reading; a sip or a page turn now and then.
    const r = Math.random();
    const prev = act.act;
    act = r < 0.42 ? ACTS[0]! : r < 0.8 ? ACTS[1]! : r < 0.9 ? ACTS[2]! : ACTS[3]!;
    if (act.act === prev && act.act !== "write" && act.act !== "read") act = ACTS[1]!;
    draw();
    const [lo, hi] = act.secs;
    actTimer = setTimeout(nextAct, (lo + Math.random() * (hi - lo)) * 1000);
  };
  nextAct();
  const drawMates = (list: Classmate[]) => {
    fill(
      mates,
      ...list.map((m, i) => {
        const el = h(
          "div",
          { class: `sh-mate m${i}` },
          h("span", { class: "sh-mate-name" }, m.name),
        );
        el.insertAdjacentHTML(
          "afterbegin",
          peepSvg(lookFor(m.id, m.hair, m.register as never), {
            pose: resting ? "arms" : "notes",
            face: resting ? "Smile" : "Calm",
          }),
        );
        return el;
      }),
    );
    scene.setAttribute(
      "aria-label",
      list.length
        ? `A study companion at the next desk, and ${list.map((m) => m.name).join(" and ")} from your class doing homework behind`
        : "A study companion working at the next desk",
    );
  };

  // --- the reader, the student who leans over, the side panel -------------------------
  const readerEl = h("section", { class: "card sh-reader", "aria-label": "Your sources" });
  let reader: Reader | null = null;
  const buddy = studyBuddy(() => school ?? null);
  let sinceAsk = 0;
  let lastTick = Date.now();

  const timer = studyTimer({
    schoolId: () => school ?? null,
    suggestions: () => {
      const out: string[] = [];
      const p = data?.prep[0];
      if (p) out.push(`Prep ${p.concept.title} for ${p.classroomName}`);
      const ch = reader?.chapterTitle();
      if (ch) out.push(`Read ${ch}`);
      if (data?.lookups.length) out.push("Look up what my class asked");
      return out;
    },
    onFocusTick: (running) => {
      const now = Date.now();
      if (running && !buddy.isOpen()) sinceAsk += now - lastTick;
      lastTick = now;
      const every = (data?.settings.interruptEveryMinutes ?? 8) * 60_000;
      if (running && sinceAsk >= every && reader) {
        sinceAsk = 0;
        void buddy.ask(reader.around());
      }
    },
    onBreak: (on) => {
      resting = on;
      draw();
      if (data) drawMates(data.classmates);
    },
    todayMinutes: () => data?.todayMinutes ?? 0,
    settings: () => data?.settings ?? { breakMinutes: 5, longStudyMinutes: 90 },
  });

  let tab: Tab = "prep";
  try {
    const t = localStorage.getItem(TAB_KEY);
    if (!conceptId && (t === "prep" || t === "notes" || t === "lot")) tab = t;
  } catch {
    /* fine */
  }
  const tabs = h("div", { class: "seg sh-tabs", role: "tablist", "aria-label": "Study tools" });
  const panes: Record<Tab, HTMLElement> = {
    prep: h("div", { role: "tabpanel" }),
    notes: h("div", { role: "tabpanel" }),
    lot: h("div", { role: "tabpanel" }),
  };
  const showTab = (t: Tab) => {
    tab = t;
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* fine */
    }
    for (const b of tabs.querySelectorAll<HTMLButtonElement>("button"))
      b.setAttribute("aria-selected", String(b.dataset.tab === t));
    for (const [k, p] of Object.entries(panes)) p.hidden = k !== t;
  };
  for (const [t, label] of [
    ["prep", "Prep for class"],
    ["notes", "Notes"],
    ["lot", "Parking lot"],
  ] as const)
    tabs.append(h("button", { role: "tab", "data-tab": t, onclick: () => showTab(t) }, label));

  let flushNotes: () => void = () => {};
  const loadSchool = () => {
    flushNotes();
    reader?.dispose();
    reader = null;
    buddy.close();
    if (!school) {
      fill(
        readerEl,
        h(
          "div",
          { class: "sh-empty" },
          h("div", { class: "h2" }, "Nothing to read yet"),
          h(
            "p",
            { class: "dim" },
            "Found a School and add a PDF or your notes: they open here, beside your study notebook.",
          ),
        ),
      );
      Object.values(panes).forEach((p) => fill(p));
      return;
    }
    const id = school;
    fill(readerEl, h("p", { class: "dim pad" }, "Opening your sources…"));
    fill(panes.lot, parkingLot(id, { add: true, title: "Parking lot" }));
    api
      .get<StudyData>(`/api/schools/${id}/study`)
      .then((d) => {
        if (school !== id) return;
        // An older server (or a test double) may leave the newer parts out.
        d.prep ??= [];
        d.lookups ??= [];
        d.classmates ??= [];
        d.todayMinutes ??= 0;
        d.settings ??= { breakMinutes: 5, longStudyMinutes: 90, interruptEveryMinutes: 8 };
        data = d;
        reader = mountReader(readerEl, d);
        readerEl.append(buddy.el);
        drawMates(d.classmates);
        fill(panes.prep, prepPanel(d, id === schoolId ? conceptId : undefined));
        const n = notebook(d);
        flushNotes = n.flush;
        fill(panes.notes, n.el);
      })
      .catch((e: Error) => fill(readerEl, h("p", { class: "error-text pad" }, e.message)));
  };

  const picker =
    schools.length > 1
      ? h(
          "select",
          {
            class: "field sh-school",
            "aria-label": "School",
            onchange: (e: Event) => {
              school = (e.target as HTMLSelectElement).value;
              loadSchool();
            },
          },
          ...schools.map((s) => h("option", { value: s.id, selected: s.id === school }, s.name)),
        )
      : null;
  const ambience = h(
    "select",
    {
      class: "field sh-ambience",
      "aria-label": "Background sound",
      onchange: (e: Event) =>
        sound.setStudyAmbience((e.target as HTMLSelectElement).value as StudyAmbience),
    },
    ...AMBIENCES.map(([v, label]) =>
      h("option", { value: v, selected: sound.studyAmbience === v }, label),
    ),
  );
  loadSchool();
  showTab(tab);

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
        picker,
        h("span", { class: "spacer" }),
        h("label", { class: "sh-sound" }, icon(ICONS.speaker), ambience),
        timer.el,
      ),
      timer.strip,
      h(
        "div",
        { class: "sh-grid" },
        readerEl,
        h(
          "aside",
          { class: "sh-side" },
          scene,
          h(
            "p",
            { class: "dim small sh-company" },
            "Someone's working beside you. Read a chapter, prep tomorrow's class, write notes.",
          ),
          tabs,
          panes.prep,
          panes.notes,
          panes.lot,
        ),
      ),
    ),
    timer.breakCard,
  );
  queueMicrotask(() => timer.startBtn.focus({ preventScroll: true }));

  return () => {
    flushNotes();
    timer.dispose();
    reader?.dispose();
    clearTimeout(actTimer);
    root.classList.remove("studyhall");
  };
}

/** One notebook per School, saved as I type. */
function notebook(d: StudyData): { el: HTMLElement; flush: () => void } {
  const area = h("textarea", {
    class: "field sh-notebook",
    "aria-label": `Study notes for ${d.school.name}`,
    placeholder:
      "Your study notes. Explain it to yourself first: what is it, why does it matter, an example.",
  }) as HTMLTextAreaElement;
  area.value = d.notes.body;
  const state = h("span", { class: "dim small", "aria-live": "polite" });
  const stamp = (iso: string | null) =>
    (state.textContent = iso
      ? `Saved ${new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso))}`
      : "Saves as you type");
  stamp(d.notes.updatedAt);
  let saved = d.notes.body;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    clearTimeout(timer);
    const body = area.value;
    if (body === saved) return;
    state.textContent = "Saving…";
    api
      .put<{ updatedAt: string }>(`/api/schools/${d.school.id}/study/notes`, { body })
      .then((r) => {
        saved = body;
        stamp(r.updatedAt);
      })
      .catch((e: unknown) => {
        state.textContent =
          e instanceof ApiError ? e.message : "Couldn't save. Still here; I'll retry.";
        timer = setTimeout(save, 4000);
      });
  };
  area.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(save, 700);
  });
  area.addEventListener("blur", save);
  const onQuote = (e: Event) => {
    const quote = (e as CustomEvent<string>).detail;
    const at = area.value && !area.value.endsWith("\n") ? "\n\n" : "";
    area.value += at + quote;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
    save();
  };
  document.addEventListener("study:quote", onQuote);

  const asSource = h(
    "button",
    {
      class: "btn small",
      onclick: () => {
        save();
        if (area.value.trim().length < 40) {
          app.notify("Write a little more first: a paragraph or so.");
          return;
        }
        asSource.disabled = true;
        const date = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(
          new Date(),
        );
        api
          .post(`/api/schools/${d.school.id}/sources`, {
            title: `My study notes (${date})`,
            text: area.value,
            kind: "notes",
          })
          .then(() =>
            app.notify(
              `Added to ${d.school.name}'s sources. The Curriculum tab will offer to fold them in.`,
            ),
          )
          .catch((e: Error) => app.notify(e.message, "error"))
          .finally(() => (asSource.disabled = false));
      },
    },
    icon(ICONS.upload),
    "Add to the School's sources",
  );

  const el = h(
    "section",
    { class: "card pad sh-notes-card", "aria-label": "Study notes" },
    h(
      "div",
      { class: "row" },
      h("div", { class: "micro" }, "Study notes"),
      h("span", { class: "spacer" }),
      state,
    ),
    area,
    h("div", { class: "row wrap-row", style: "margin-top:10px" }, asSource),
  );
  return {
    el,
    flush: () => {
      document.removeEventListener("study:quote", onQuote);
      save();
    },
  };
}
