import type { Archetype } from "@lumen/shared";
import { currentLayout, onLayout, type Layout } from "../../core/layout";
import { reducedMotion } from "../theme";
import { lookFor, peepSvg, restingFace, type Look, type Pose } from "../peeps/peep";
import { BUST_H, BUST_W, deskLayout, deskMarkup, escapeXml, type Desk } from "./Room";
import "./room.css";

// The exam hall (docs/02 §5.2, M6-09, ADR-009): the class sits the exam at
// their desks, heads down, writing. Each graded answer lands as a stamp on
// that student's paper (✓, ½ or ✗) and their face shows it; the board keeps
// the question number and, at the end, the class score with a PASSED or
// NOT YET stamp. Same calls as the old 3D arena (anchors.withArena).

export interface ArenaCadet {
  id: string;
  name?: string;
  archetype: Archetype;
}

const W = 1600;
const H = 1000;
const NS = "http://www.w3.org/2000/svg";
/** Part B: framed like the classroom on a phone held upright (fitted, not cropped). */
const FRAMES: Record<Layout, { box: string; fit: string }> = {
  regular: { box: `0 0 ${W} ${H}`, fit: "xMidYMid slice" },
  landscape: { box: "0 20 1600 780", fit: "xMidYMin slice" },
  portrait: { box: "200 40 1180 960", fit: "xMidYMin meet" },
};

interface Seat {
  g: SVGGElement;
  bust: SVGGElement;
  stamp: SVGGElement;
  look: Look;
  desk: Desk;
  archetype: Archetype;
}

function hallMarkup(): string {
  const floorTop = 500;
  const window = (x: number) => `
    <g class="window" transform="translate(${x} 70)">
      <rect class="win-shadow" x="8" y="8" width="110" height="330"/>
      <rect class="win-frame" width="110" height="330"/>
      <rect x="9" y="9" width="92" height="312" fill="url(#hall-sky)"/>
      <path d="M9 120 h92 M55 9 v312 M9 230 h92" class="mullion"/>
      <path class="arch" d="M0 0 q55 -60 110 0z"/>
    </g>`;
  return `
    <defs>
      <linearGradient id="hall-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fd3fb"/><stop offset="1" stop-color="#e3f6ff"/></linearGradient>
      <pattern id="hall-dots" width="14" height="14" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.2" class="dot"/></pattern>
    </defs>
    <g class="room-back">
      <rect class="wall" x="0" y="0" width="${W}" height="${floorTop}"/>
      <rect x="0" y="0" width="${W}" height="${floorTop}" fill="url(#hall-dots)"/>
      <rect class="wainscot" x="0" y="430" width="${W}" height="${floorTop - 430}"/>
      <line class="trim" x1="0" y1="430" x2="${W}" y2="430"/>
      <rect class="floor" x="0" y="${floorTop}" width="${W}" height="${H - floorTop}"/>
      <g class="boards">${Array.from({ length: 12 }, (_, i) => `<line x1="0" y1="${floorTop + 30 + i * i * 4}" x2="${W}" y2="${floorTop + 30 + i * i * 4}"/>`).join("")}</g>
      <line class="trim thick" x1="0" y1="${floorTop}" x2="${W}" y2="${floorTop}"/>
      ${window(60)}${window(220)}${window(1270)}${window(1430)}
      <g class="clock" transform="translate(870 72)">
        <circle class="face" r="40"/>
        ${Array.from({ length: 12 }, (_, i) => `<line class="tick" x1="0" y1="-33" x2="0" y2="${i % 3 ? -29 : -25}" transform="rotate(${i * 30})"/>`).join("")}
        <line class="hand hour" x1="0" y1="5" x2="0" y2="-18"/>
        <line class="hand minute" x1="0" y1="6" x2="0" y2="-28"/>
        <line class="hand second" x1="0" y1="8" x2="0" y2="-31"/>
        <circle class="pin" r="3.5"/>
      </g>
      <g class="sign" transform="translate(1188 150)">
        <rect class="sign-shadow" x="5" y="5" width="120" height="44"/>
        <rect class="sign-plate" width="120" height="44"/>
        <text x="60" y="20" text-anchor="middle">EXAM</text>
        <text x="60" y="36" text-anchor="middle" class="small sign-state">IN PROGRESS</text>
      </g>
    </g>
    <g class="board-wrap">
      <rect class="board-shadow" x="588" y="138" width="580" height="250"/>
      <rect class="board" x="580" y="130" width="580" height="250"/>
      <rect class="board-inner" x="594" y="144" width="552" height="222"/>
      <foreignObject x="608" y="154" width="524" height="204">
        <div xmlns="http://www.w3.org/1999/xhtml" class="board-text exam-board"></div>
      </foreignObject>
      <g class="verdict" transform="translate(1030 300) rotate(-8)"></g>
    </g>
    <g class="desks"></g>`;
}

export class ExamHall {
  readonly el: HTMLElement;
  private readonly root: SVGSVGElement;
  private readonly desksG: SVGGElement;
  private readonly boardText: HTMLElement;
  private readonly verdict: SVGGElement;
  private readonly seats = new Map<string, Seat>();
  private readonly clock: { h: SVGElement; m: SVGElement; s: SVGElement };
  private readonly still = reducedMotion();
  private raf = 0;
  private readonly offLayout: () => void;
  private pass = 0.6;
  private question = { ord: 0, total: 0, concept: "", kind: "" };
  private result: { avg: number; passed: boolean } | null = null;

  constructor(stage: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "room hall";
    this.root = document.createElementNS(NS, "svg");
    const frame = (l: Layout) => {
      this.root.setAttribute("viewBox", FRAMES[l].box);
      this.root.setAttribute("preserveAspectRatio", FRAMES[l].fit);
    };
    frame(currentLayout());
    this.offLayout = onLayout(frame);
    this.root.setAttribute("role", "img");
    this.root.setAttribute("aria-label", "The exam hall");
    this.root.innerHTML = hallMarkup();
    this.el.append(this.root);
    stage.prepend(this.el);
    this.desksG = this.root.querySelector(".desks")!;
    this.boardText = this.root.querySelector(".board-text")!;
    this.verdict = this.root.querySelector(".verdict")!;
    this.clock = {
      h: this.root.querySelector(".clock .hour")!,
      m: this.root.querySelector(".clock .minute")!,
      s: this.root.querySelector(".clock .second")!,
    };
    this.renderBoard();
    this.tick();
  }

  setCadets(list: ArenaCadet[]): void {
    this.seats.clear();
    this.desksG.innerHTML = "";
    const desks = deskLayout(list.length);
    const order = desks
      .map((d, i) => ({ d, c: list[i] }))
      .sort((a, b) => a.d.y - b.d.y || a.d.x - b.d.x);
    for (const { d, c } of order) {
      if (!c) continue; // exam desks are spaced: no empty ones drawn
      const g = document.createElementNS(NS, "g");
      g.setAttribute("class", "seat");
      const bust = document.createElementNS(NS, "g");
      bust.setAttribute("class", "bust");
      const bw = BUST_W * d.s;
      const bh = BUST_H * d.s;
      bust.setAttribute("transform", `translate(${d.x - bw / 2} ${d.y - bh + 46 * d.s})`);
      bust.style.setProperty("--i", `${(d.x * 7 + d.y) % 11}`);
      const stamp = document.createElementNS(NS, "g");
      stamp.setAttribute("class", "stamp");
      stamp.setAttribute(
        "transform",
        `translate(${d.x + 62 * d.s} ${d.y - 4 * d.s}) scale(${d.s})`,
      );
      g.append(bust);
      g.insertAdjacentHTML(
        "beforeend",
        deskMarkup(d, c.id, (c.name ?? "").split(" ")[0] ?? "") +
          `<g transform="translate(${d.x + 40 * d.s} ${d.y - 6 * d.s}) scale(${d.s})"><rect class="paper" x="-26" y="-10" width="52" height="16" transform="skewX(-20)"/></g>`,
      );
      g.append(stamp);
      this.desksG.append(g);
      const seat: Seat = { g, bust, stamp, look: lookFor(c.id), desk: d, archetype: c.archetype };
      this.seats.set(c.id, seat);
      this.draw(seat, "notes", "Driven");
    }
  }

  private draw(seat: Seat, pose: Pose, face: NonNullable<Parameters<typeof peepSvg>[1]>["face"]) {
    const w = BUST_W * seat.desk.s;
    seat.bust.innerHTML = peepSvg(seat.look, { pose, face }).replace(
      "<svg ",
      `<svg width="${w}" height="${(w * 1130.6) / 940.3}" `,
    );
  }

  setPassMark(pass: number): void {
    this.pass = pass;
    this.renderBoard();
  }

  /** The DOM card carries the live meter; the board only needs it at the end. */
  setIntegrity(_v: number): void {}

  setQuestion(ord: number, total: number, concept: string, kind: string): void {
    this.question = { ord, total, concept, kind };
    this.renderBoard();
  }

  /** One graded answer: a stamp on that student's paper, and their face shows it. */
  answer(cadetId: string, score: number): void {
    const seat = this.seats.get(cadetId);
    if (!seat) return;
    const v = score >= 0.6 ? "ok" : score >= 0.3 ? "mid" : "bad";
    const mark = v === "ok" ? "✓" : v === "mid" ? "½" : "✗";
    seat.stamp.innerHTML = `<g class="pop ${v}"><circle r="22"/><text y="9" text-anchor="middle">${mark}</text></g>`;
    this.draw(seat, "idle", v === "ok" ? "BigSmile" : v === "mid" ? "Concerned" : "Fear");
    // Back to the paper after a moment (unless the exam has ended).
    setTimeout(() => {
      if (!this.result && this.seats.get(cadetId) === seat) this.draw(seat, "notes", "Driven");
    }, 1600);
  }

  finish(avg: number, passed: boolean): void {
    this.result = { avg, passed };
    this.renderBoard();
    this.verdict.innerHTML = `<g class="pop ${passed ? "pass" : "fail"}"><rect x="-96" y="-30" width="192" height="60"/><text y="12" text-anchor="middle">${passed ? "PASSED" : "NOT YET"}</text></g>`;
    for (const seat of this.seats.values())
      this.draw(seat, passed ? "hand" : "idle", passed ? "BigSmile" : restingFace(seat.archetype));
    this.el.classList.toggle("cheer", passed && !this.still);
    const state = this.root.querySelector(".sign-state");
    if (state) state.textContent = "FINISHED";
  }

  private renderBoard() {
    const q = this.question;
    if (this.result) {
      const pct = Math.round(this.result.avg * 100);
      this.boardText.innerHTML = `
        <div class="b-label">Class score</div>
        <div class="b-score">${pct}%</div>
        <div class="b-meter"><span>Pass ${Math.round(this.pass * 100)}%</span><i><b style="width:${pct}%"></b></i></div>`;
      return;
    }
    this.boardText.innerHTML = q.total
      ? `<div class="b-label">Question ${q.ord} of ${q.total} · ${escapeXml(q.kind)}</div>
         <div class="b-title">${escapeXml(q.concept)}</div>
         <p class="b-last">Pens down when the bell rings. Pass mark ${Math.round(this.pass * 100)}%.</p>`
      : `<div class="b-label">Exam</div><div class="b-title">Take your seats…</div>`;
  }

  private tick = () => {
    const now = new Date();
    const sec = now.getSeconds();
    const min = now.getMinutes() + sec / 60;
    const hr = (now.getHours() % 12) + min / 60;
    this.clock.h.setAttribute("transform", `rotate(${hr * 30})`);
    this.clock.m.setAttribute("transform", `rotate(${min * 6})`);
    this.clock.s.setAttribute("transform", `rotate(${sec * 6})`);
    this.raf = requestAnimationFrame(this.tick);
  };

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.offLayout();
    this.el.remove();
  }
}
