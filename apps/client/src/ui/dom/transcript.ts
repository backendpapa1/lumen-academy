import type { ClassroomState } from "../../core/classroom";
import { store } from "../../core/store";
import "./overlay.css";

// Transcript drawer (docs/02 §3.3): the whole conversation, searchable.

const aside = document.createElement("aside");
aside.id = "transcript";
aside.setAttribute("aria-label", "Transcript");
aside.innerHTML = `<h2>Transcript</h2><input type="search" placeholder="Search what was said" aria-label="Search the transcript" /><ol></ol>`;
document.querySelector("#stage")!.appendChild(aside);
const search = aside.querySelector("input")!;
const list = aside.querySelector("ol")!;

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function render(c: ClassroomState) {
  const q = search.value.trim().toLowerCase();
  const rows = c.transcript.filter((t) => !q || t.text.toLowerCase().includes(q));
  list.innerHTML = rows
    .map((t) => {
      const who = t.speaker === "headmaster" ? "You" : (c.cadets[t.cadetId ?? ""]?.name ?? "Cadet");
      let text = esc(t.text);
      if (q)
        text = text.replace(
          new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
          (m) => `<mark>${m}</mark>`,
        );
      return `<li class="${t.speaker}"><div class="who">${esc(who)}</div><div>${text}</div></li>`;
    })
    .join("");
  if (!q) list.scrollTop = list.scrollHeight;
}

search.addEventListener("input", () => render(store.getState().classroom));
store.subscribe((s, p) => {
  if (s.classroom.transcript !== p.classroom.transcript && aside.classList.contains("open"))
    render(s.classroom);
});

export const transcript = {
  toggle(open = !aside.classList.contains("open")) {
    aside.classList.toggle("open", open);
    if (open) {
      render(store.getState().classroom);
      search.focus();
    }
    return open;
  },
  get open() {
    return aside.classList.contains("open");
  },
};
