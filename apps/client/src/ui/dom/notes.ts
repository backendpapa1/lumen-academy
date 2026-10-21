import { ARCHETYPE_INFO, type Archetype } from "@lumen/shared";
import { api } from "../../core/api";
import { app } from "../../core/app";
import { store } from "../../core/store";
import { portrait } from "../screens/common";
import { fill, h } from "../screens/dom";

// Peek at notes (T-8): a cadet's own summary of what you taught. It can be
// wrong: those are your errors or their misconceptions. N toggles, Esc closes.

const panel = h("aside", { class: "notes-panel", hidden: true, "aria-label": "Student notes" });
document.querySelector("#stage")!.append(panel);
let openFor: string | null = null;

/** Light Markdown: headings, bullets and **bold**; everything else plain text. */
function render(md: string): HTMLElement {
  const out = h("div", { class: "notes-body" });
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const heading = /^#{1,3}\s+(.*)/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)/.exec(line);
    const text = heading?.[1] ?? bullet?.[1] ?? line;
    const el = h(heading ? "h3" : bullet ? "li" : "p", {});
    // **bold** spans, as text nodes (never innerHTML).
    text
      .split(/(\*\*[^*]+\*\*)/)
      .forEach((part) =>
        el.append(
          part.startsWith("**") && part.endsWith("**")
            ? h("b", {}, part.slice(2, -2))
            : document.createTextNode(part),
        ),
      );
    out.append(el);
  }
  return out;
}

export async function toggleNotes(cadetId?: string | null) {
  const id = cadetId ?? store.getState().selectedId ?? store.getState().hoveredId;
  if (!panel.hidden && (!id || id === openFor)) return closeNotes();
  if (!id) return app.notify("Pick a student first: Tab through the hands, or click one.");
  openFor = id;
  const c = store.getState().classroom.cadets[id];
  panel.hidden = false;
  fill(panel, h("p", { class: "dim" }, "Opening their notes…"));
  try {
    const n = await api.get<{ name: string; archetype: Archetype; notes: string }>(
      `/api/cadets/${id}/notes`,
    );
    if (openFor !== id) return;
    fill(
      panel,
      h(
        "div",
        { class: "row", style: "gap:12px;margin-bottom:12px" },
        c ? portrait(c) : null,
        h(
          "div",
          {},
          h("div", { class: "micro" }, "Notes"),
          h("div", { class: "h2", style: `color:${ARCHETYPE_INFO[n.archetype].accent}` }, n.name),
        ),
        h("span", { class: "spacer" }),
        h(
          "button",
          { class: "btn small quiet", "aria-label": "Close notes", onclick: closeNotes },
          "×",
        ),
      ),
      n.notes.trim()
        ? render(n.notes)
        : h(
            "p",
            { class: "dim" },
            "No notes yet. Students write them up at the end of each class.",
          ),
      h(
        "p",
        { class: "dim notes-foot" },
        "Their own words. Anything wrong here is something they misheard, or something you said.",
      ),
    );
  } catch (e) {
    fill(panel, h("p", { class: "error-text" }, (e as Error).message));
  }
}

export function closeNotes() {
  panel.hidden = true;
  openFor = null;
}

panel.addEventListener("keydown", (e) => e.key === "Escape" && closeNotes());
store.subscribe((s, p) => s.route !== p.route && closeNotes());
