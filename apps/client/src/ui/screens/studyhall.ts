import { api, ApiError } from "../../core/api";
import { app } from "../../core/app";
import { sound } from "../../core/audio";
import { SERVER_HTTP } from "../../core/net";
import { store } from "../../core/store";
import { lookFor, peepSvg, type Pose } from "../peeps/peep";
import { fill, h, icon, ICONS } from "./dom";
import { parkingLot } from "./parkingLot";
import "./studyhall.css";

// Study hall (V3-06, and Paul's note): a study session with company. A quiet
// drawn person works at the next desk (body doubling: no AI, just presence)
// while I read my own sources right here, the PDF itself or the text the
// School indexed, and write study notes beside them. A calm timer, and my
// parking lot for stray thoughts.

const COMPANION = lookFor("cdt_study_companion", "short", "male");
/** What the companion is doing, and roughly for how long (seconds). */
const ACTS: Array<{ act: "write" | "read" | "sip" | "page"; pose: Pose; secs: [number, number] }> =
  [
    { act: "write", pose: "notes", secs: [24, 48] },
    { act: "read", pose: "idle", secs: [20, 40] },
    { act: "sip", pose: "idle", secs: [5, 7] },
    { act: "page", pose: "idle", secs: [3, 4] },
  ];
const PRESETS = [15, 25, 45];
const LAST_SOURCE = "lumen.studySource";

interface StudySource {
  id: string;
  title: string;
  kind: string;
  url: string | null;
  pages: number | null;
  original: boolean;
}
interface StudyData {
  school: { id: string; name: string };
  sources: StudySource[];
  notes: { body: string; updatedAt: string | null };
}
interface SourceText {
  title: string;
  url: string | null;
  sections: Array<{ heading: string | null; page: number | null; text: string }>;
}

export function mountStudyHall(root: HTMLElement, schoolId?: string): () => void {
  root.classList.add("studyhall");
  const schools = store.getState().setup.schools ?? [];
  let school = schoolId ?? schools[0]?.id;

  // --- the companion: a lamp-lit desk by a rainy window ------------------------
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

  // --- the calm timer -----------------------------------------------------------
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

  // --- the reader, the notebook and the parking lot, per School ----------------
  const reader = h("section", { class: "card sh-reader", "aria-label": "Your sources" });
  const notesSlot = h("div");
  const lotSlot = h("div");
  let flushNotes: () => void = () => {};

  const loadSchool = () => {
    flushNotes();
    if (!school) {
      fill(
        reader,
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
      fill(notesSlot);
      fill(lotSlot);
      return;
    }
    const id = school;
    fill(reader, h("p", { class: "dim pad" }, "Opening your sources…"));
    fill(lotSlot, parkingLot(id, { add: true, title: "Parking lot" }));
    api
      .get<StudyData>(`/api/schools/${id}/study`)
      .then((d) => {
        if (school !== id) return;
        mountReader(reader, d);
        const n = notebook(d);
        flushNotes = n.flush;
        fill(notesSlot, n.el);
      })
      .catch((e: Error) => fill(reader, h("p", { class: "error-text pad" }, e.message)));
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
  loadSchool();

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
        h("section", { class: "sh-timer", "aria-label": "Timer" }, digits, presetRow, startBtn),
      ),
      h(
        "div",
        { class: "sh-grid" },
        reader,
        h(
          "aside",
          { class: "sh-side" },
          scene,
          h(
            "p",
            { class: "dim small sh-company" },
            "Someone's working beside you. Read a source, write notes, sketch tomorrow's lesson.",
          ),
          notesSlot,
          lotSlot,
        ),
      ),
    ),
  );
  queueMicrotask(() => startBtn.focus({ preventScroll: true }));

  return () => {
    flushNotes();
    clearInterval(tick);
    clearTimeout(actTimer);
    root.classList.remove("studyhall");
  };
}

/** The School's sources: the PDF in the browser's own viewer, everything else as text. */
function mountReader(el: HTMLElement, d: StudyData) {
  if (!d.sources.length) {
    fill(
      el,
      h(
        "div",
        { class: "sh-empty" },
        h("div", { class: "h2" }, "No sources ready yet"),
        h(
          "p",
          { class: "dim" },
          `Add a PDF, notes or a link on ${d.school.name}'s Sources tab, and it opens here.`,
        ),
        h(
          "button",
          { class: "btn", onclick: () => app.openSchool(d.school.id, "sources") },
          "Open Sources",
        ),
      ),
    );
    return;
  }
  let remembered: string | null = null;
  try {
    remembered = localStorage.getItem(`${LAST_SOURCE}.${d.school.id}`);
  } catch {
    /* fine */
  }
  let current = d.sources.find((s) => s.id === remembered) ?? d.sources[0]!;
  let mode: "original" | "text" = current.original ? "original" : "text";
  const body = h("div", { class: "sh-page" });
  const bar = h("div", { class: "sh-bar" });

  const fileUrl = () => `${SERVER_HTTP}/api/schools/${d.school.id}/sources/${current.id}/file`;
  const render = () => {
    try {
      localStorage.setItem(`${LAST_SOURCE}.${d.school.id}`, current.id);
    } catch {
      /* fine */
    }
    fill(
      bar,
      d.sources.length > 1
        ? h(
            "select",
            {
              class: "field",
              "aria-label": "Source",
              onchange: (e: Event) => {
                current = d.sources.find((s) => s.id === (e.target as HTMLSelectElement).value)!;
                mode = current.original ? "original" : "text";
                render();
              },
            },
            ...d.sources.map((s) =>
              h("option", { value: s.id, selected: s.id === current.id }, s.title),
            ),
          )
        : h("b", { class: "sh-title" }, current.title),
      h("span", { class: "spacer" }),
      current.original &&
        h(
          "div",
          { class: "seg", role: "group", "aria-label": "View" },
          ...(["original", "text"] as const).map((m) =>
            h(
              "button",
              {
                "aria-pressed": String(mode === m),
                onclick: () => {
                  mode = m;
                  render();
                },
              },
              m === "original" ? "PDF" : "Text",
            ),
          ),
        ),
      mode === "text" &&
        h(
          "button",
          {
            class: "btn small",
            title: "Select some text first",
            onclick: () => quoteSelection(body, current.title),
          },
          icon(ICONS.pencil),
          "Add selection to notes",
        ),
      current.url &&
        h(
          "a",
          { class: "btn small quiet", href: current.url, target: "_blank", rel: "noreferrer" },
          "Open the link",
        ),
      mode === "original" &&
        h(
          "a",
          { class: "btn small quiet", href: fileUrl(), target: "_blank", rel: "noreferrer" },
          "Open in a new tab",
        ),
    );
    if (mode === "original") {
      fill(
        body,
        h("iframe", {
          class: "sh-pdf",
          title: current.title,
          src: `${fileUrl()}#view=FitH`,
        }),
      );
      return;
    }
    fill(body, h("p", { class: "dim pad" }, "Opening…"));
    const id = current.id;
    api
      .get<SourceText>(`/api/schools/${d.school.id}/sources/${id}/text`)
      .then((t) => current.id === id && fill(body, article(t)))
      .catch((e: Error) => fill(body, h("p", { class: "error-text pad" }, e.message)));
  };
  fill(el, bar, body);
  render();
}

/** The indexed text, with headings and page marks; text nodes only, never HTML. */
function article(t: SourceText): HTMLElement {
  const out = h("article", { class: "sh-text" }, h("h2", { class: "h2" }, t.title));
  let lastHeading: string | null = null;
  let lastPage: number | null = null;
  for (const s of t.sections) {
    if (s.page !== null && s.page !== lastPage) {
      out.append(h("div", { class: "sh-pagemark mono small" }, `p. ${s.page}`));
      lastPage = s.page;
    }
    const heading = s.heading?.split(" > ").at(-1) ?? null;
    if (heading && heading !== lastHeading) {
      out.append(h("h3", {}, heading));
      lastHeading = heading;
    }
    for (const para of s.text.split(/\n{2,}/)) {
      const line = para.trim();
      if (!line) continue;
      const md = /^(#{1,6})\s+(.*)$/.exec(line);
      out.append(md ? h("h4", {}, md[2]!) : h("p", {}, line));
    }
  }
  return out;
}

/** "Add selection to notes": the quote, and where it came from. */
function quoteSelection(scope: HTMLElement, title: string) {
  const sel = getSelection();
  const text = sel?.toString().trim() ?? "";
  if (!text || !sel?.anchorNode || !scope.contains(sel.anchorNode)) {
    app.notify("Select a passage in the text first.");
    return;
  }
  const page = sel.anchorNode.parentElement?.closest(".sh-text")?.querySelectorAll(".sh-pagemark");
  let mark = "";
  // The last page mark before the selection.
  page?.forEach((m) => {
    if (m.compareDocumentPosition(sel.anchorNode!) & Node.DOCUMENT_POSITION_FOLLOWING)
      mark = m.textContent ?? "";
  });
  document.dispatchEvent(
    new CustomEvent("study:quote", {
      detail: `> ${text.replace(/\n+/g, " ")}\n> (${title}${mark ? `, ${mark}` : ""})\n\n`,
    }),
  );
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
