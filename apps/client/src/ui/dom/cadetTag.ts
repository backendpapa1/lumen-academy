import { ARCHETYPE_INFO } from "@lumen/shared";
import { store } from "../../core/store";
import { world } from "../../world/anchors";
import { accentCss } from "../theme";
import "./overlay.css";

// Hover tag: who's under the pointer, their archetype, and how well they've
// got the current concept. Follows the pointer; never takes pointer events.

const tag = document.createElement("div");
tag.id = "cadet-tag";
tag.setAttribute("aria-hidden", "true"); // the roster is the accessible view of the same data
document.querySelector("#stage")!.appendChild(tag);

store.subscribe((s, prev) => {
  if (s.hoveredId === prev.hoveredId && s.classroom.cadets === prev.classroom.cadets) return;
  const cadet = s.hoveredId ? s.classroom.cadets[s.hoveredId] : undefined;
  tag.classList.toggle("shown", !!cadet);
  if (!cadet) return;
  const pct = Math.round(cadet.comprehension * 100);
  tag.style.setProperty("--accent", accentCss(cadet.archetype));
  tag.innerHTML = "";
  const name = document.createElement("b");
  name.textContent = cadet.name;
  const meta = document.createElement("span");
  meta.textContent = `${ARCHETYPE_INFO[cadet.archetype].label} · ${pct}% understood`;
  tag.append(name, meta);
});

function follow() {
  const p = world.pointer;
  if (p && tag.classList.contains("shown"))
    tag.style.transform = `translate(${p.x + 16}px, ${p.y + 18}px)`;
  requestAnimationFrame(follow);
}
requestAnimationFrame(follow);
