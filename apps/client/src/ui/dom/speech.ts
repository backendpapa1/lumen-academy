import type { Speech } from "../../core/classroom";
import { store } from "../../core/store";
import { voice } from "../../core/voice";
import { anchors } from "../../world/anchors";
import { accentCss, reducedMotion } from "../theme";
import { lingerMs, revealStep } from "./typewriter";
import "./overlay.css";

// The speaking cadet's speech panel (docs/02 §3.2): floats above them, joined
// by a light line, and types the stream in. A Leak Guard rewrite (cadet.rewrite)
// shimmers across the panel and swaps the text underneath it.

const TOP = 84; // below the top bar
const RIGHT = 340; // clear of the hand rail
const GAP = 40; // head to panel

const stage = document.querySelector<HTMLElement>("#stage")!;
const line = document.createElement("div");
line.id = "speech-line";
const panel = document.createElement("div");
panel.id = "speech";
panel.setAttribute("aria-hidden", "true"); // typed text would chatter; the live region speaks
panel.innerHTML = `<div class="who"></div><p></p>`;
const live = document.createElement("div");
live.className = "sr-only";
live.setAttribute("aria-live", "polite");
stage.append(line, panel, live);
const who = panel.querySelector<HTMLElement>(".who")!;
const body = panel.querySelector("p")!;

let speech: Speech | null = null;
let shown = 0;
let doneAt = 0;
let rephrasedAt: number | undefined;
let last = performance.now();

store.subscribe((s, prev) => {
  const next = s.route.name === "classroom" ? s.classroom.speech : null;
  if (next === prev.classroom.speech && s.route === prev.route) return;
  if (next && next.streamId !== speech?.streamId) {
    shown = 0;
    doneAt = 0;
    rephrasedAt = undefined;
    const cadet = s.classroom.cadets[next.cadetId];
    // V4-01: a line to a classmate says who it's for.
    const p = s.classroom.peer;
    const toId =
      p?.speakerId === next.cadetId
        ? p.listenerId
        : p?.listenerId === next.cadetId
          ? p.speakerId
          : null;
    const to = toId ? s.classroom.cadets[toId]?.name.split(" ")[0] : null;
    who.textContent = `${cadet?.name ?? "Student"}${to ? ` → ${to}` : ""}`;
    panel.style.setProperty("--accent", cadet ? accentCss(cadet.archetype) : "var(--lumen)");
  }
  if (next?.done && !doneAt) {
    doneAt = performance.now();
    live.textContent = `${who.textContent}: ${next.text}`;
  }
  if (next?.rephrasedAt && next.rephrasedAt !== rephrasedAt) {
    rephrasedAt = next.rephrasedAt;
    doneAt = performance.now(); // give the new wording its own reading time
    live.textContent = `${who.textContent}: ${next.text}`;
    rephrase(next.text);
  }
  speech = next;
});

/** Shimmer across the panel; swap the words while it covers them. */
function rephrase(text: string) {
  if (reducedMotion()) {
    shown = text.length;
    return;
  }
  panel.classList.remove("rephrasing");
  void panel.offsetWidth; // restart the animation
  panel.classList.add("rephrasing");
  setTimeout(() => (shown = text.length), 320);
  setTimeout(() => panel.classList.remove("rephrasing"), 900);
}

function frame(now: number) {
  const dt = Math.min(0.25, (now - last) / 1000); // slow frames still keep pace
  last = now;
  const anchor = anchors.speaker;
  // With voice on, the bubble keeps pace with the audio and stays until they've finished.
  const talking = !!speech && voice.isSpeaking(speech.streamId);
  if (talking && doneAt) doneAt = now;
  const expired = doneAt > 0 && now - doneAt > lingerMs(speech?.text ?? "");
  const visible = !!speech && !!anchor && !expired;
  panel.classList.toggle("shown", visible);
  line.classList.toggle("shown", visible);
  if (speech && anchor) {
    const cap = voice.revealCap(speech.streamId);
    const target = cap === null ? speech.text.length : Math.min(cap, speech.text.length);
    shown = reducedMotion() ? target : Math.min(target, revealStep(shown, target, dt, speech.done));
    const n = Math.floor(shown);
    const typed = speech.text.slice(0, n);
    if (body.textContent !== typed) body.textContent = typed;
    panel.classList.toggle("typing", n < speech.text.length || !speech.done);
    place(anchor.x, anchor.y);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function place(x: number, y: number) {
  const w = panel.offsetWidth;
  const h = panel.offsetHeight;
  const maxLeft = Math.max(24, stage.clientWidth - RIGHT - w);
  const left = Math.min(maxLeft, Math.max(24, x - w / 2));
  const top = Math.max(TOP, y - GAP - h);
  panel.style.transform = `translate(${left}px, ${top}px)`;
  // Light line from the panel's lower edge (nearest point) down to the head.
  const fromX = Math.min(left + w - 16, Math.max(left + 16, x));
  const fromY = top + h;
  const dx = x - fromX;
  const dy = y - fromY;
  const len = Math.max(0, Math.hypot(dx, dy));
  line.style.width = `${len}px`;
  line.style.transform = `translate(${fromX}px, ${fromY}px) rotate(${Math.atan2(dy, dx)}rad)`;
}
