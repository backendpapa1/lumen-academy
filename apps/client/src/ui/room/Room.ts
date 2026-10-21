import { REACTION_GLYPHS, type ReactionState } from "@lumen/shared";
import type { CadetState, ClassroomState } from "../../core/classroom";
import { app } from "../../core/app";
import { store } from "../../core/store";
import { voice } from "../../core/voice";
import { anchors, world } from "../../world/anchors";
import { dayPhase } from "../../world/lighting";
import { FACE_FOR, lookFor, peepSvg, restingFace, type Look, type Pose } from "../peeps/peep";
import "./room.css";

// The classroom (ADR-009): a drawn room seen from the teacher's desk. Windows
// on the left, the whiteboard on the back wall, up to three rows of five desks
// in perspective. Students are Open Peeps who raise their hands, talk, frown
// and take notes. The whole room is one SVG scaled to cover the stage.

const W = 1600;
const H = 1000;
const NS = "http://www.w3.org/2000/svg";
const CX = 760; // the class sits a little left of centre: the hand rail is on the right

/** Rows from the front: desk-top height, scale, spacing (virtual px). */
const ROWS = [
  { y: 792, s: 0.92, gap: 226 },
  { y: 636, s: 0.75, gap: 188 },
  { y: 520, s: 0.6, gap: 152 },
] as const;
const PER_ROW = 5;
/** The bust's drawn size at scale 1. */
export const BUST_W = 168;
export const BUST_H = (BUST_W * 1130.6) / 940.3;

export interface Desk {
  x: number;
  y: number;
  s: number;
}

/** Desks for n students: front row first, every row five desks wide. */
export function deskLayout(n: number): Desk[] {
  const rows = Math.min(ROWS.length, Math.max(1, Math.ceil(n / PER_ROW)));
  const out: Desk[] = [];
  for (let r = 0; r < rows; r++) {
    const row = ROWS[r]!;
    for (let i = 0; i < PER_ROW; i++)
      out.push({ x: CX + (i - (PER_ROW - 1) / 2) * row.gap, y: row.y, s: row.s });
  }
  return out;
}

const svg = <K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  html?: string,
): SVGElementTagNameMap[K] => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (html !== undefined) el.innerHTML = html;
  return el;
};

function rng(seed: string) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    return ((h ^= h >>> 13) >>> 0) / 4294967296;
  };
}

/** V4-06: what each sticker looks like on the corkboard. */
const STICKER_GLYPH: Record<string, string> = {
  best_analogy: "💡",
  fixed_confusion: "✓",
  brave_correction: "★",
  landed: "🎯",
};

// --- the room itself ----------------------------------------------------------

const SKIES = {
  dawn: ["#ffd9c2", "#ffeede"],
  day: ["#8fd3fb", "#d8f2ff"],
  dusk: ["#ffb08f", "#ffd9b8"],
  night: ["#1a2580", "#3b4fd0"],
} as const;

function roomMarkup(): string {
  const phase = dayPhase();
  const [skyTop, skyLow] = SKIES[phase];
  const night = phase === "night";
  // Floorboards run toward a vanishing point above the board.
  const vx = 780;
  const vy = 300;
  const floorTop = 500;
  const boards = Array.from({ length: 17 }, (_, i) => {
    const bx = -500 + i * 162;
    const t = (floorTop - vy) / (H - vy);
    return `<line x1="${vx + (bx - vx) * t}" y1="${floorTop}" x2="${bx}" y2="${H}"/>`;
  }).join("");
  const seams = [540, 600, 690, 820, 990]
    .map((y) => `<line x1="0" y1="${y}" x2="${W}" y2="${y}"/>`)
    .join("");
  const wainscot = Array.from(
    { length: 20 },
    (_, i) => `<rect x="${i * 84 + 8}" y="${432}" width="68" height="52" rx="2"/>`,
  ).join("");
  const window = (x: number) => `
    <g class="window" transform="translate(${x} 92)">
      <rect class="win-shadow" x="8" y="8" width="150" height="310"/>
      <rect class="win-frame" width="150" height="310"/>
      <rect x="10" y="10" width="130" height="290" fill="url(#sky)"/>
      <g clip-path="url(#pane-${x})">
        ${
          night
            ? `<g class="stars">${Array.from({ length: 14 }, (_, i) => `<circle cx="${((i * 47) % 130) + 10}" cy="${((i * 83) % 200) + 18}" r="${i % 3 ? 1.4 : 2.2}"/>`).join("")}</g>`
            : `<g class="cloud" style="--d:${x % 3}"><path d="M10 80 q10 -22 30 -14 q10 -20 32 -8 q22 -4 22 16 q14 2 12 16 h-96 q-12 -2 0 -10z"/></g>`
        }
        <path class="hill" d="M0 250 q60 -50 130 -10 q40 -20 80 0 v70 h-210z"/>
        <g class="tree"><rect x="${x % 2 ? 92 : 30}" y="206" width="6" height="60"/><circle cx="${x % 2 ? 95 : 33}" cy="196" r="26"/><circle cx="${x % 2 ? 112 : 50}" cy="214" r="18"/></g>
      </g>
      <clipPath id="pane-${x}"><rect x="10" y="10" width="130" height="290"/></clipPath>
      <line class="mullion" x1="75" y1="10" x2="75" y2="300"/>
      <line class="mullion" x1="10" y1="150" x2="140" y2="150"/>
      <rect class="sill" x="-10" y="310" width="170" height="14"/>
    </g>`;
  const lamp = (x: number) => `
    <g class="lamp" transform="translate(${x} 0)">
      <line x1="0" y1="0" x2="0" y2="22"/>
      <path d="M-46 22 h92 l-12 18 h-68z"/>
      <ellipse class="glow" cx="0" cy="44" rx="40" ry="6"/>
    </g>`;
  return `
    <defs>
      <radialGradient id="spot-g">
        <stop offset="0.5" stop-color="#000"/><stop offset="1" stop-color="#fff"/>
      </radialGradient>
      <mask id="spot" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">
        <rect width="${W}" height="${H}" fill="#fff"/>
        <ellipse cx="${CX}" cy="${ROWS[0].y - 110}" rx="300" ry="330" fill="url(#spot-g)"/>
      </mask>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${skyTop}"/><stop offset="1" stop-color="${skyLow}"/>
      </linearGradient>
      <pattern id="dots" width="14" height="14" patternUnits="userSpaceOnUse">
        <circle cx="2" cy="2" r="1.2" class="dot"/>
      </pattern>
    </defs>
    <g class="room-back">
      <rect class="wall" x="0" y="0" width="${W}" height="${floorTop}"/>
      <rect class="wall-dots" x="0" y="40" width="${W}" height="380" fill="url(#dots)"/>
      <rect class="ceiling" x="0" y="0" width="${W}" height="36"/>
      <line class="trim" x1="0" y1="36" x2="${W}" y2="36"/>
      <rect class="wainscot" x="0" y="420" width="${W}" height="${floorTop - 420}"/>
      <g class="wainscot-panels">${wainscot}</g>
      <line class="trim" x1="0" y1="420" x2="${W}" y2="420"/>
      <rect class="floor" x="0" y="${floorTop}" width="${W}" height="${H - floorTop}"/>
      <g class="boards">${boards}${seams}</g>
      <line class="trim thick" x1="0" y1="${floorTop}" x2="${W}" y2="${floorTop}"/>
      ${lamp(330)}${lamp(800)}${lamp(1270)}
      ${window(36)}${window(206)}
      <g class="plant" transform="translate(372 368)">
        <path class="leaf" d="M30 40 C 0 20 -6 -10 10 -30 C 18 0 30 14 30 40z"/>
        <path class="leaf" d="M30 40 C 60 18 70 -14 52 -36 C 44 -4 30 12 30 40z"/>
        <path class="leaf" d="M30 40 C 22 4 26 -30 38 -50 C 46 -20 40 10 30 40z"/>
        <path class="pot" d="M8 40 h44 l-6 46 h-32z"/>
      </g>
      <g class="clock" transform="translate(1268 120)">
        <circle class="face" r="46"/>
        ${Array.from({ length: 12 }, (_, i) => `<line class="tick" x1="0" y1="-38" x2="0" y2="${i % 3 ? -33 : -29}" transform="rotate(${i * 30})"/>`).join("")}
        <line class="hand hour" x1="0" y1="6" x2="0" y2="-22"/>
        <line class="hand minute" x1="0" y1="8" x2="0" y2="-33"/>
        <line class="hand second" x1="0" y1="10" x2="0" y2="-36"/>
        <circle class="pin" r="4"/>
      </g>
      <g class="corkboard" transform="translate(1214 206)">
        <rect class="cork-shadow" x="6" y="6" width="120" height="150"/>
        <rect class="cork" width="120" height="150"/>
        <rect class="note n1" x="12" y="14" width="44" height="40" transform="rotate(-4 34 34)"/>
        <rect class="note n2" x="64" y="20" width="44" height="36" transform="rotate(5 86 38)"/>
        <rect class="note n3" x="18" y="70" width="86" height="30" transform="rotate(1 60 85)"/>
        <rect class="note n4" x="40" y="108" width="50" height="32" transform="rotate(-3 65 124)"/>
        <g class="pins"><circle cx="34" cy="18" r="3"/><circle cx="86" cy="24" r="3"/><circle cx="60" cy="73" r="3"/><circle cx="65" cy="112" r="3"/></g>
        <g class="stickers"></g>
      </g>
      <g class="door" transform="translate(1388 134)">
        <rect class="door-shadow" x="8" y="8" width="168" height="366"/>
        <rect class="door-frame" x="-10" y="-10" width="188" height="376"/>
        <rect class="door-leaf" width="168" height="366"/>
        <rect class="door-glass" x="34" y="34" width="100" height="120"/>
        <line class="mullion" x1="84" y1="34" x2="84" y2="154"/>
        <rect class="door-panel" x="34" y="196" width="100" height="130"/>
        <circle class="knob" cx="142" cy="214" r="8"/>
      </g>
    </g>
    <g class="board-wrap">
      <rect class="board-shadow" x="452" y="80" width="700" height="300"/>
      <rect class="board" x="444" y="72" width="700" height="300"/>
      <rect class="board-inner" x="458" y="86" width="672" height="272"/>
      <foreignObject x="472" y="96" width="644" height="252">
        <div xmlns="http://www.w3.org/1999/xhtml" class="board-text"></div>
      </foreignObject>
      <rect class="tray" x="560" y="372" width="468" height="12"/>
      <rect class="marker m1" x="600" y="364" width="54" height="9" rx="3"/>
      <rect class="marker m2" x="664" y="364" width="54" height="9" rx="3"/>
      <rect class="marker m3" x="728" y="364" width="54" height="9" rx="3"/>
      <rect class="eraser" x="900" y="358" width="70" height="16"/>
    </g>
    <g class="desks"></g>
    <g class="teacher-desk">
      <rect class="td-top" x="-20" y="936" width="${W + 40}" height="80"/>
      <line class="trim thick" x1="0" y1="936" x2="${W}" y2="936"/>
      <g transform="translate(1340 870)">
        <rect class="book b1" x="0" y="44" width="120" height="22"/>
        <rect class="book b2" x="10" y="24" width="104" height="20"/>
        <rect class="book b3" x="4" y="6" width="112" height="18"/>
        <path class="mug" d="M150 22 h44 v44 h-44z M194 32 q18 0 18 14 q0 14 -18 14"/>
        <path class="apple" d="M244 66 c-22 0 -26 -30 -12 -38 c6 -4 12 -2 14 0 c2 -2 8 -4 14 0 c14 8 10 38 -12 38z M246 28 q2 -10 8 -14"/>
      </g>
    </g>
    <rect class="dim" x="0" y="0" width="${W}" height="${H}"/>`;
}

// --- one student at a desk ------------------------------------------------------

interface Seat {
  id: string;
  g: SVGGElement;
  bust: SVGGElement;
  emote: SVGGElement;
  badge: SVGGElement;
  desk: Desk;
  look: Look;
  drawn: string;
  glyph: string;
  arrived: boolean;
}

export function deskMarkup(d: Desk, seed: string, name: string): string {
  const r = rng(seed);
  const w = 206;
  const items = [
    `<rect class="item book" x="${-70 + r() * 40}" y="-14" width="52" height="16" transform="rotate(${-8 + r() * 16})"/>`,
    `<line class="item pencil" x1="${10 + r() * 30}" y1="-6" x2="${54 + r() * 20}" y2="${-12 + r() * 8}"/>`,
    r() < 0.4 ? `<rect class="item cup" x="${60 + r() * 14}" y="-26" width="18" height="22"/>` : "",
  ].join("");
  return `
    <g class="desk" transform="translate(${d.x} ${d.y}) scale(${d.s})">
      <path class="desk-top" d="M${-w / 2 + 8} -14 h${w - 16} l8 22 h${-w} z"/>
      <rect class="desk-front" x="${-w / 2}" y="8" width="${w}" height="70"/>
      <rect class="desk-side" x="${w / 2}" y="8" width="8" height="70"/>
      <line class="desk-leg" x1="${-w / 2 + 14}" y1="78" x2="${-w / 2 + 14}" y2="108"/>
      <line class="desk-leg" x1="${w / 2 - 14}" y1="78" x2="${w / 2 - 14}" y2="108"/>
      ${items}
      ${name ? `<g class="plate"><rect x="-58" y="26" width="116" height="28"/><text x="0" y="45" text-anchor="middle">${escapeXml(name)}</text></g>` : ""}
    </g>`;
}

export const escapeXml = (s: string) =>
  s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);

const GLYPH_CLASS: Partial<Record<ReactionState, string>> = {
  confused: "coral",
  excited: "marigold",
  skeptical: "cobalt",
  bored: "dim",
  notetaking: "cobalt",
};

export class Room {
  readonly el: HTMLElement;
  private readonly root: SVGSVGElement;
  private readonly desksG: SVGGElement;
  private readonly boardText: HTMLElement;
  private readonly seats = new Map<string, Seat>();
  private readonly unsubscribe: () => void;
  private readonly offVoice: () => void;
  private layoutKey = "";
  private raf = 0;
  private flickerTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEventId: string | null = null;
  private readonly clock: { h: SVGElement; m: SVGElement; s: SVGElement };

  /** arrivals: students walk in and sit as they join (registration). */
  constructor(
    stage: HTMLElement,
    private readonly opts: { arrivals?: boolean; interactive?: boolean } = {},
  ) {
    this.el = document.createElement("div");
    this.el.className = "room";
    this.root = svg("svg", {
      viewBox: `0 0 ${W} ${H}`,
      preserveAspectRatio: "xMidYMid slice",
      role: "img",
      "aria-label": "Your classroom",
    });
    this.root.innerHTML = roomMarkup();
    this.el.append(this.root);
    stage.prepend(this.el);
    this.desksG = this.root.querySelector(".desks")!;
    this.boardText = this.root.querySelector(".board-text")!;
    this.clock = {
      h: this.root.querySelector(".clock .hour")!,
      m: this.root.querySelector(".clock .minute")!,
      s: this.root.querySelector(".clock .second")!,
    };

    this.unsubscribe = store.subscribe((s, prev) => {
      if (s.classroom !== prev.classroom) this.sync(s.classroom);
      if (s.hoveredId !== prev.hoveredId || s.selectedId !== prev.selectedId)
        this.highlight(s.hoveredId, s.selectedId);
    });
    this.sync(store.getState().classroom);
    this.offVoice = voice.on(() => this.sync(store.getState().classroom));
    if (opts.interactive !== false) this.wirePointer();
    world.pick = this.pick;
    this.tick();
  }

  // --- state → drawing ------------------------------------------------------

  private sync(c: ClassroomState) {
    const students = Object.values(c.cadets).sort((a, b) => a.seat - b.seat);
    const micro = c.kind === "micro";
    const key = `${micro}|${students.map((x) => x.id).join(",")}`;
    if (key !== this.layoutKey) this.relayout(students, micro);
    const queue = c.hands.map((h) => h.cadetId);
    const speaking = c.speech && !c.speech.done ? c.speech.cadetId : (c.speech?.cadetId ?? null);
    // V3-05: on a break the class stretches (arms up) and chats.
    const onBreak = !!c.breakUntil && c.clock.paused;
    this.el.classList.toggle("break", onBreak);
    for (const [i, st] of students.entries()) {
      const seat = this.seats.get(st.id);
      if (!seat) continue;
      if (onBreak) {
        this.drawStudent(seat, i % 2 ? "arms" : "hand", restingFace(st.archetype));
        this.setEmote(seat, i % 3 === 1 ? "…" : "", "attentive");
        this.setBadge(seat, 0);
        seat.g.classList.remove("speaking");
        continue;
      }
      const pos = queue.indexOf(st.id);
      const pose: Pose =
        speaking === st.id
          ? "talk"
          : pos >= 0
            ? "hand"
            : st.state === "notetaking"
              ? "notes"
              : st.state === "skeptical"
                ? "arms"
                : "idle";
      // With voice on, the mouth follows the audio (lip-sync lite, V1-07).
      const face =
        speaking === st.id
          ? voice.state.speaking === st.id && !voice.state.mouthOpen
            ? "Calm"
            : "Explaining"
          : st.state === "attentive"
            ? restingFace(st.archetype)
            : FACE_FOR[st.state];
      this.drawStudent(seat, pose, face);
      this.setEmote(seat, speaking === st.id ? "" : REACTION_GLYPHS[st.state], st.state);
      this.setBadge(seat, pos >= 0 && speaking !== st.id ? pos + 1 : 0);
      seat.g.classList.toggle("speaking", speaking === st.id);
      // V4-01: in a peer exchange, whoever isn't talking leans toward the one who is.
      const peer = c.peer;
      const other =
        peer?.speakerId === st.id
          ? peer.listenerId
          : peer?.listenerId === st.id
            ? peer.speakerId
            : null;
      const otherSeat = other ? this.seats.get(other) : undefined;
      seat.g.classList.toggle("listening", !!otherSeat && speaking !== st.id);
      if (otherSeat)
        seat.g.style.setProperty("--lean", otherSeat.desk.x > seat.desk.x ? "1" : "-1");
    }
    this.board(c);
    this.corkboard(c);
    this.el.classList.toggle("focus", c.hyperfocus);
    this.el.classList.toggle("micro", micro);
    // V5-05: in the ELI-5 round the class is younger, drawn smaller.
    this.el.classList.toggle("eli5", c.kind === "eli_ladder" && c.eli?.level === "eli5");
    if (c.event && c.event.id !== this.lastEventId) {
      this.lastEventId = c.event.id;
      if (c.event.kind === "power_flicker") this.flicker();
    }
    this.highlight(store.getState().hoveredId, store.getState().selectedId);
  }

  private relayout(students: CadetState[], micro = false) {
    this.layoutKey = `${micro}|${students.map((x) => x.id).join(",")}`;
    const desks = deskLayout(students.length);
    // V3-01: a micro-lesson's one student sits front and centre, under the light.
    const seated: Array<CadetState | undefined> = micro
      ? desks.map((_, i) => (i === Math.floor(PER_ROW / 2) ? students[0] : undefined))
      : students;
    const byId = new Map(seated.flatMap((s, i) => (s ? [[s.id, desks[i]!] as const] : [])));
    // Remove students who left.
    for (const [id, seat] of this.seats)
      if (!byId.has(id)) {
        seat.g.remove();
        this.seats.delete(id);
      }
    this.desksG.innerHTML = "";
    // Back row first so nearer desks overlap farther students.
    const order = desks
      .map((d, i) => ({ d, st: seated[i] }))
      .sort((a, b) => a.d.y - b.d.y || a.d.x - b.d.x);
    for (const { d, st } of order) {
      if (!st) {
        this.desksG.insertAdjacentHTML(
          "beforeend",
          `<g class="seat empty">${deskMarkup(d, `${d.x},${d.y}`, "")}</g>`,
        );
        continue;
      }
      let seat = this.seats.get(st.id);
      const fresh = !seat;
      if (!seat) {
        const g = svg("g", { class: "seat", "data-id": st.id, tabindex: -1 });
        seat = {
          id: st.id,
          g,
          bust: svg("g", { class: "bust" }),
          emote: svg("g", { class: "emote" }),
          badge: svg("g", { class: "badge" }),
          desk: d,
          look: lookFor(st.id),
          drawn: "",
          glyph: "",
          arrived: !this.opts.arrivals,
        };
        this.seats.set(st.id, seat);
      }
      seat.desk = d;
      const g = seat.g;
      g.innerHTML = "";
      const bw = BUST_W * d.s;
      const bh = BUST_H * d.s;
      // The bust sits behind the desk: chest hidden by the desk front.
      seat.bust.setAttribute("transform", `translate(${d.x - bw / 2} ${d.y - bh + 46 * d.s})`);
      seat.bust.style.setProperty("--w", `${bw}`);
      seat.bust.style.setProperty("--i", `${(d.x * 7 + d.y) % 11}`);
      seat.drawn = "";
      const hx = d.x + 30 * d.s;
      const hy = d.y - bh + 30 * d.s;
      seat.emote.setAttribute(
        "transform",
        `translate(${hx + 44 * d.s} ${hy + 4 * d.s}) scale(${d.s})`,
      );
      seat.badge.setAttribute(
        "transform",
        `translate(${d.x - 66 * d.s} ${hy + 16 * d.s}) scale(${d.s})`,
      );
      g.append(seat.bust);
      g.insertAdjacentHTML("beforeend", deskMarkup(d, st.id, st.name.split(" ")[0]!));
      g.append(seat.emote, seat.badge);
      this.desksG.append(g);
      if (fresh && this.opts.arrivals) {
        g.classList.add("arriving");
        g.addEventListener("animationend", () => g.classList.remove("arriving"), { once: true });
      }
    }
  }

  private drawStudent(seat: Seat, pose: Pose, face: keyof typeof FACE_FOR | string) {
    const key = `${pose}:${face}`;
    if (seat.drawn === key) return;
    const raised = pose === "hand" && !seat.drawn.startsWith("hand");
    seat.drawn = key;
    const w = Number(seat.bust.style.getPropertyValue("--w")) || BUST_W;
    seat.bust.innerHTML = peepSvg(seat.look, { pose, face: face as never }).replace(
      "<svg ",
      `<svg width="${w}" height="${(w * 1130.6) / 940.3}" `,
    );
    if (raised) {
      seat.g.classList.remove("raise");
      void seat.g.getBoundingClientRect();
      seat.g.classList.add("raise");
    }
  }

  private setEmote(seat: Seat, glyph: string, state: ReactionState) {
    if (seat.glyph === glyph) return;
    seat.glyph = glyph;
    seat.emote.innerHTML = glyph
      ? `<g class="pop ${GLYPH_CLASS[state] ?? ""}"><circle class="bubble-shadow" cx="3" cy="3" r="21"/><circle class="bubble" r="21"/><path class="tail" d="M-14 12 l-8 12 l16 -6z"/><text y="8" text-anchor="middle">${glyph}</text></g>`
      : "";
  }

  private setBadge(seat: Seat, n: number) {
    const now = seat.badge.dataset.n ?? "";
    if (now === String(n || "")) return;
    seat.badge.dataset.n = n ? String(n) : "";
    seat.badge.innerHTML = n
      ? `<g class="pop"><circle r="17"/><text y="6" text-anchor="middle">${n}</text></g>`
      : "";
  }

  private board(c: ClassroomState) {
    const last = [...c.transcript].reverse().find((t) => t.speaker === "headmaster")?.text ?? "";
    const avg = c.classAverage;
    const parked = c.parking.open;
    const wall = c.glossary.slice(0, 5);
    const key = `${c.concept?.title}|${c.board}|${last}|${avg}|${c.lastTaughtDays}|${parked}|${wall.map((t) => t.term + t.definition).join("·")}`;
    if (this.boardText.dataset.key === key) return;
    this.boardText.dataset.key = key;
    const lines = c.board
      .split("\n")
      .filter(Boolean)
      .map((l) => `<li>${escapeXml(l)}</li>`)
      .join("");
    this.boardText.innerHTML = `
      <div class="b-label">${
        c.lastTaughtDays && c.lastTaughtDays >= 1 && !c.transcript.length
          ? `Today · last taught ${c.lastTaughtDays === 1 ? "yesterday" : `${c.lastTaughtDays} days ago`}`
          : "Today"
      }</div>
      <div class="b-title">${escapeXml(c.concept?.title ?? "Waiting for the class…")}</div>
      ${lines ? `<ul class="b-notes">${lines}</ul>` : last ? `<p class="b-last">“${escapeXml(last.length > 150 ? `${last.slice(0, 147)}…` : last)}”</p>` : ""}
      ${
        avg === null
          ? ""
          : `<div class="b-meter"><span>Class understanding</span><i><b style="width:${Math.round(avg * 100)}%"></b></i><em>${Math.round(avg * 100)}%</em></div>`
      }
      ${
        wall.length
          ? `<div class="b-wall" aria-label="Glossary wall"><div class="b-wall-h">On the wall</div>${wall
              .map(
                (t) =>
                  `<div class="b-term${t.agrees ? "" : " disputed"}" title="${escapeXml(t.agrees ? t.definition : `${t.definition} (${t.note ?? "doesn't match your sources"})`)}"><b>${escapeXml(t.term)}</b> ${escapeXml(t.definition.length > 70 ? `${t.definition.slice(0, 67)}…` : t.definition)}</div>`,
              )
              .join("")}</div>`
          : ""
      }
      ${parked ? `<div class="b-sticky" title="Parked thoughts: they wait for you at the bell"><b>${parked}</b>parked</div>` : ""}`;
  }

  /** V4-06: the class's stickers, pinned over the corkboard notes (latest on top). */
  private corkboard(c: ClassroomState) {
    const g = this.root.querySelector<SVGGElement>(".corkboard .stickers");
    if (!g) return;
    const key = c.stickers.map((s) => s.id).join(",");
    if (g.dataset.key === key) return;
    const fresh = g.dataset.key !== undefined && c.stickers[0]?.id !== g.dataset.key.split(",")[0];
    g.dataset.key = key;
    const spots = [
      [28, 30],
      [84, 40],
      [36, 88],
      [88, 96],
      [30, 136],
      [86, 138],
    ];
    g.innerHTML = c.stickers
      .slice(0, spots.length)
      .reverse()
      .map((s, i, all) => {
        const [x, y] = spots[all.length - 1 - i]!;
        const glyph = STICKER_GLYPH[s.kind] ?? "★";
        const who = c.cadets[s.cadetId]?.name.split(" ")[0] ?? "";
        const pop = fresh && i === all.length - 1 ? " fresh" : "";
        // The pop animates the inner group, so it never overrides the position.
        return `<g transform="translate(${x} ${y}) rotate(${((i * 37) % 24) - 12})"><g class="sticker ${escapeXml(s.kind)}${pop}"><title>${escapeXml(`${s.label} (from ${who})`)}</title><circle r="17"/><text y="6" text-anchor="middle">${glyph}</text></g></g>`;
      })
      .join("");
  }

  private highlight(hovered: string | null, selected: string | null) {
    for (const [id, seat] of this.seats) {
      seat.g.classList.toggle("hovered", id === hovered);
      seat.g.classList.toggle("selected", id === selected);
    }
  }

  /** The lights stutter and sag for five seconds (power flicker event). */
  private flicker() {
    this.el.classList.remove("flicker");
    void this.el.offsetWidth;
    this.el.classList.add("flicker");
    if (this.flickerTimer) clearTimeout(this.flickerTimer);
    this.flickerTimer = setTimeout(() => this.el.classList.remove("flicker"), 5200);
  }

  // --- pointer, speaker anchor, clock ------------------------------------------

  private wirePointer() {
    const idAt = (t: EventTarget | null) =>
      (t instanceof Element && t.closest<SVGGElement>(".seat[data-id]")?.dataset.id) || null;
    this.root.addEventListener("pointermove", (e) => {
      const id = idAt(e.target);
      if (store.getState().hoveredId !== id) store.setState({ hoveredId: id });
      const r = this.el.getBoundingClientRect();
      world.pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
    });
    this.root.addEventListener("pointerleave", () => {
      if (store.getState().hoveredId) store.setState({ hoveredId: null });
    });
    this.root.addEventListener("click", (e) => {
      const id = idAt(e.target);
      app.select(id);
      if (id && store.getState().classroom.hands.some((h) => h.cadetId === id)) app.call(id);
    });
  }

  private readonly pick = (x: number, y: number): string | null => {
    const r = this.el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + x, r.top + y);
    return (
      (hit instanceof Element && hit.closest<SVGGElement>(".seat[data-id]")?.dataset.id) || null
    );
  };

  private tick = () => {
    const c = store.getState().classroom;
    const id = c.speech?.cadetId;
    const seat = id ? this.seats.get(id) : undefined;
    if (seat) {
      const b = seat.bust.getBoundingClientRect();
      const r = this.el.getBoundingClientRect();
      anchors.speaker = { x: b.left - r.left + b.width * 0.55, y: b.top - r.top + b.height * 0.12 };
    } else anchors.speaker = null;
    const now = new Date();
    const sec = now.getSeconds();
    const min = now.getMinutes() + sec / 60;
    const hr = (now.getHours() % 12) + min / 60;
    this.clock.h.setAttribute("transform", `rotate(${hr * 30})`);
    this.clock.m.setAttribute("transform", `rotate(${min * 6})`);
    this.clock.s.setAttribute("transform", `rotate(${sec * 6})`);
    this.raf = requestAnimationFrame(this.tick);
  };

  dispose() {
    cancelAnimationFrame(this.raf);
    if (this.flickerTimer) clearTimeout(this.flickerTimer);
    this.unsubscribe();
    this.offVoice();
    if (world.pick === this.pick) world.pick = null;
    anchors.speaker = null;
    this.el.remove();
  }
}
