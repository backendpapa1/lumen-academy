import { dayPhase } from "../../world/lighting";
import "./campus.css";

// The campus behind the lobby (ADR-009, docs/02 §1): a drawn school grounds.
// The Academy hall stands at the back; each School is a building on a plot
// around the lawn, drawn at its tier: a blueprint, scaffolding, a building, a
// tower, then a landmark with a dome and a flag. Same contract as the old 3D
// campus (setWings / flyTo / setFog), so campusSync drives either.

export interface WingInfo {
  schoolId: string;
  slot: number;
  tier: number;
  accent: string;
  emblemUrl: string | null;
  decalUrl: string | null;
}

const W = 1600;
const H = 1000;
const NS = "http://www.w3.org/2000/svg";
// The first Schools take the plots right of the path, which the lobby never covers.
const SLOTS = [
  { x: 1430, y: 884, s: 0.9 },
  { x: 1508, y: 668, s: 0.64 },
  { x: 952, y: 872, s: 0.9 },
  { x: 838, y: 664, s: 0.64 },
  { x: 700, y: 912, s: 0.86 },
  { x: 1660, y: 772, s: 0.7 },
] as const;
/** How tall each tier stands, for the pin above it. */
const TOP = [240, 300, 250, 420, 420];

const SKY = {
  dawn: ["#ffd2bd", "#fff1e4"],
  day: ["#8fd3fb", "#e3f6ff"],
  dusk: ["#ffad8c", "#ffe3c9"],
  night: ["#1a2580", "#4a5fd8"],
} as const;

const esc = (s: string) =>
  s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);

/** One School's building at its tier, base centred on (0,0). */
export function buildingMarkup(tier: number, accent: string, emblemUrl: string | null): string {
  const w = 236;
  const hw = w / 2;
  const body = 150;
  const windows = (rows: number) =>
    Array.from({ length: rows * 4 }, (_, i) => {
      const col = i % 4;
      const row = Math.floor(i / 4);
      const x = -hw + 22 + col * 52 + (col > 1 ? 16 : 0);
      const y = -body + 26 + row * 48;
      return `<g class="win"><rect x="${x}" y="${y}" width="30" height="32"/><line x1="${x + 15}" y1="${y}" x2="${x + 15}" y2="${y + 32}"/><line x1="${x}" y1="${y + 16}" x2="${x + 30}" y2="${y + 16}"/></g>`;
    }).join("");
  const emblem = emblemUrl
    ? `<clipPath id="em-${accent.slice(1)}"><circle cx="0" cy="${-body - 30}" r="22"/></clipPath><circle class="seal" cx="0" cy="${-body - 30}" r="25"/><image href="${esc(emblemUrl)}" x="-22" y="${-body - 52}" width="44" height="44" clip-path="url(#em-${accent.slice(1)})" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle class="seal" cx="0" cy="${-body - 30}" r="25"/><circle class="seal-in" cx="0" cy="${-body - 30}" r="12" style="fill:${accent}"/>`;

  if (tier <= 0) {
    // Blueprint: the outline on grid paper, a peg and string around the plot.
    return `
      <g class="b blueprint">
        <rect class="plot" x="${-hw - 16}" y="-8" width="${w + 32}" height="22"/>
        <rect class="paper" x="${-hw}" y="${-body}" width="${w}" height="${body}"/>
        <path class="paper" d="M${-hw - 10} ${-body} L0 ${-body - 64} L${hw + 10} ${-body}z"/>
        <g class="dash">
          <rect x="${-hw + 20}" y="${-body + 26}" width="${w - 40}" height="40"/>
          <rect x="-22" y="-62" width="44" height="62"/>
        </g>
        <g class="pegs"><line x1="${-hw - 16}" y1="4" x2="${-hw - 16}" y2="-26"/><line x1="${hw + 16}" y1="4" x2="${hw + 16}" y2="-26"/></g>
        <g class="tag" transform="translate(${hw - 6} -34) rotate(8)"><rect x="-34" y="-14" width="68" height="26"/><text y="5" text-anchor="middle">PLANNED</text></g>
      </g>`;
  }
  if (tier === 1) {
    // Frame: scaffolding, a slab, the first wall, a crane.
    const posts = [-hw, -hw / 2, 0, hw / 2, hw]
      .map((x) => `<line x1="${x}" y1="0" x2="${x}" y2="${-body}"/>`)
      .join("");
    const beams = [-50, -100, -150]
      .map((y) => `<line x1="${-hw}" y1="${y}" x2="${hw}" y2="${y}"/>`)
      .join("");
    const braces = [-hw, -hw / 2, 0, hw / 2]
      .map((x) => `<line x1="${x}" y1="-50" x2="${x + hw / 2}" y2="-100"/>`)
      .join("");
    return `
      <g class="b frame">
        <rect class="shadow" x="${-hw + 8}" y="-42" width="${w}" height="50"/>
        <rect class="slab" x="${-hw - 10}" y="-6" width="${w + 20}" height="12"/>
        <rect class="wall" x="${-hw}" y="-50" width="${w}" height="44"/>
        <g class="scaffold">${posts}${beams}${braces}</g>
        <g class="crane">
          <line x1="${hw + 40}" y1="6" x2="${hw + 40}" y2="-250"/>
          <line x1="${hw - 120}" y1="-240" x2="${hw + 74}" y2="-240"/>
          <line x1="${hw + 40}" y1="-250" x2="${hw - 60}" y2="-240"/>
          <rect class="counter" x="${hw + 60}" y="-248" width="20" height="20" style="fill:${accent}"/>
          <line class="cable" x1="${hw - 90}" y1="-240" x2="${hw - 90}" y2="-176"/>
          <rect class="load" x="${hw - 104}" y="-176" width="28" height="18"/>
        </g>
      </g>`;
  }
  const roofBand = `<rect class="cornice" x="${-hw - 8}" y="${-body - 14}" width="${w + 16}" height="16" style="fill:${accent}"/>`;
  const door = `<path class="door" d="M-24 0 v-54 q24 -22 48 0 v54z" style="fill:${accent}"/><line class="door-line" x1="0" y1="-62" x2="0" y2="0"/>`;
  const steps = `<rect class="step" x="-40" y="-4" width="80" height="8"/>`;
  const base = `
    <rect class="shadow" x="${-hw + 9}" y="${-body + 9}" width="${w}" height="${body}"/>
    <rect class="facade" x="${-hw}" y="${-body}" width="${w}" height="${body}"/>
    ${windows(2)}
    ${roofBand}
    ${door}${steps}`;
  if (tier === 2)
    return `
      <g class="b wing">
        ${base}
        <path class="gable" d="M${-hw + 30} ${-body - 14} L0 ${-body - 70} L${hw - 30} ${-body - 14}z"/>
        ${emblem}
      </g>`;
  // Tower and Landmark: a tower rises from the middle.
  const tower = `
    <rect class="shadow" x="-38" y="${-body - 132}" width="76" height="132"/>
    <rect class="tower" x="-46" y="${-body - 140}" width="92" height="140"/>
    <circle class="clock-face" cx="0" cy="${-body - 92}" r="22"/>
    <line class="clock-hand" x1="0" y1="${-body - 92}" x2="0" y2="${-body - 108}"/>
    <line class="clock-hand" x1="0" y1="${-body - 92}" x2="12" y2="${-body - 92}"/>
    <rect class="tower-win" x="-14" y="${-body - 56}" width="28" height="36"/>`;
  if (tier === 3)
    return `
      <g class="b tower-tier">
        ${base}
        ${tower}
        <path class="spire" d="M-54 ${-body - 140} L0 ${-body - 214} L54 ${-body - 140}z" style="fill:${accent}"/>
        <line class="pole" x1="0" y1="${-body - 214}" x2="0" y2="${-body - 250}"/>
      </g>`;
  return `
    <g class="b landmark">
      <rect class="hedge" x="${-hw - 30}" y="-22" width="70" height="26" rx="13"/>
      <rect class="hedge" x="${hw - 40}" y="-22" width="70" height="26" rx="13"/>
      ${base}
      <g class="banners"><rect x="${-hw + 6}" y="${-body + 4}" width="14" height="70" style="fill:${accent}"/><rect x="${hw - 20}" y="${-body + 4}" width="14" height="70" style="fill:${accent}"/></g>
      ${tower}
      <path class="dome" d="M-50 ${-body - 140} q50 -96 100 0z"/>
      <line class="pole" x1="0" y1="${-body - 188}" x2="0" y2="${-body - 250}"/>
      <path class="flag" d="M0 ${-body - 250} h46 l-10 12 l10 12 h-46z" style="fill:${accent}"/>
      <g class="sparkles"><path d="M${-hw - 6} ${-body - 40} l4 -12 l4 12 l12 4 l-12 4 l-4 12 l-4 -12 l-12 -4z"/><path d="M${hw + 4} ${-body - 90} l3 -9 l3 9 l9 3 l-9 3 l-3 9 l-3 -9 l-9 -3z"/></g>
    </g>`;
}

function grounds(): string {
  const phase = dayPhase();
  const [top, low] = SKY[phase];
  const night = phase === "night";
  const tree = (x: number, y: number, s: number) =>
    `<g class="tree" transform="translate(${x} ${y}) scale(${s})"><rect x="-5" y="-40" width="10" height="44"/><circle cx="0" cy="-62" r="34"/><circle cx="-22" cy="-44" r="20"/><circle cx="24" cy="-46" r="22"/></g>`;
  return `
    <defs>
      <linearGradient id="c-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${low}"/></linearGradient>
      <pattern id="c-grid" width="16" height="16" patternUnits="userSpaceOnUse"><path d="M16 0 H0 V16" class="grid-line"/></pattern>
    </defs>
    <rect x="0" y="0" width="${W}" height="${H}" fill="url(#c-sky)"/>
    ${
      night
        ? `<g class="stars">${Array.from({ length: 40 }, (_, i) => `<circle cx="${(i * 389) % W}" cy="${(i * 137) % 380}" r="${i % 4 ? 1.5 : 2.5}"/>`).join("")}</g><circle class="moon" cx="1390" cy="150" r="46"/>`
        : `<g class="sun"><circle cx="1400" cy="150" r="58"/>${Array.from({ length: 12 }, (_, i) => `<line x1="0" y1="-76" x2="0" y2="-96" transform="translate(1400 150) rotate(${i * 30})"/>`).join("")}</g>`
    }
    <g class="clouds">
      <path class="cloud c1" d="M820 190 q16 -36 52 -24 q16 -32 56 -14 q36 -6 38 26 q24 4 20 28 h-160 q-22 -4 -6 -16z"/>
      <path class="cloud c2" d="M1160 110 q12 -26 38 -18 q12 -24 42 -10 q26 -4 28 20 q18 2 14 20 h-118 q-16 -2 -4 -12z"/>
      <path class="cloud c3" d="M540 260 q12 -26 38 -18 q12 -24 42 -10 q26 -4 28 20 q18 2 14 20 h-118 q-16 -2 -4 -12z"/>
    </g>
    <path class="hill far" d="M0 560 q200 -110 420 -40 q220 -120 480 -20 q240 -110 700 -30 v120 h-1600z"/>
    <path class="hill near" d="M0 600 q260 -80 560 -10 q300 -70 620 -6 q240 -50 420 -10 v60 h-1600z"/>
    <rect class="lawn" x="0" y="590" width="${W}" height="${H - 590}"/>
    <path class="path" d="M1160 590 C 1150 700 1060 760 1010 ${H} L1330 ${H} C 1300 780 1210 700 1200 590z"/>
    <g class="bench" transform="translate(1260 760)"><rect x="0" y="0" width="70" height="10"/><rect x="0" y="-16" width="70" height="8"/><line x1="8" y1="10" x2="8" y2="26"/><line x1="62" y1="10" x2="62" y2="26"/></g>
    <g class="bushes"><circle cx="1096" cy="640" r="16"/><circle cx="1120" cy="644" r="12"/><circle cx="1252" cy="642" r="14"/><circle cx="1274" cy="638" r="18"/></g>
    ${tree(700, 640, 0.9)}${tree(1580, 610, 0.8)}${tree(960, 560, 0.62)}${tree(1380, 560, 0.62)}
    <g class="hall" transform="translate(1180 588)">
      <rect class="shadow" x="-202" y="-182" width="400" height="190"/>
      <rect class="facade" x="-210" y="-190" width="400" height="190"/>
      ${Array.from({ length: 6 }, (_, i) => `<rect class="col" x="${-176 + i * 66}" y="-150" width="16" height="150"/>`).join("")}
      <path class="pediment" d="M-226 -190 L-10 -262 L206 -190z"/>
      <rect class="sign" x="-120" y="-182" width="220" height="28"/>
      <text class="sign-text" x="-10" y="-162" text-anchor="middle">LUMEN ACADEMY</text>
      <rect class="tower" x="-44" y="-372" width="68" height="112"/>
      <circle class="clock-face" cx="-10" cy="-328" r="24"/>
      <line class="clock-hand" x1="-10" y1="-328" x2="-10" y2="-346"/>
      <line class="clock-hand" x1="-10" y1="-328" x2="4" y2="-328"/>
      <path class="roof" d="M-56 -372 L-10 -430 L36 -372z"/>
      <line class="pole" x1="-10" y1="-430" x2="-10" y2="-470"/>
      <path class="flag hall-flag" d="M-10 -470 h44 l-10 11 l10 11 h-44z"/>
      <path class="door" d="M-38 0 v-70 q28 -26 56 0 v70z"/>
      <rect class="step" x="-70" y="-6" width="120" height="10"/>
    </g>
    <g class="plots"></g>
    <g class="weather"></g>`;
}

export class Campus {
  readonly el: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly plots: SVGGElement;
  private readonly weather: SVGGElement;
  private readonly wings = new Map<string, { g: SVGGElement; info: WingInfo }>();
  private focused: string | null = null;

  constructor(stage: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "campus";
    this.svg = document.createElementNS(NS, "svg");
    this.svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    this.svg.setAttribute("preserveAspectRatio", "xMaxYMid slice");
    this.svg.setAttribute("aria-hidden", "true");
    this.svg.innerHTML = grounds();
    this.el.append(this.svg);
    stage.prepend(this.el);
    this.plots = this.svg.querySelector(".plots")!;
    this.weather = this.svg.querySelector(".weather")!;
  }

  /** Sync buildings with the campus data; returns the Schools that just tiered up. */
  setWings(list: WingInfo[], seenTiers: Record<string, number>): string[] {
    const up: string[] = [];
    for (const [id, w] of this.wings)
      if (!list.some((x) => x.schoolId === id)) {
        w.g.remove();
        this.wings.delete(id);
      }
    // Draw back plots first so nearer buildings overlap them.
    const sorted = list
      .slice(0, SLOTS.length)
      .map((info, i) => ({ info, slot: SLOTS[info.slot % SLOTS.length] ?? SLOTS[i]! }))
      .sort((a, b) => a.slot.y - b.slot.y);
    for (const { info, slot } of sorted) {
      const seen = seenTiers[info.schoolId];
      const grew = seen !== undefined && info.tier > seen;
      if (grew) up.push(info.schoolId);
      let w = this.wings.get(info.schoolId);
      const key = `${info.tier}|${info.accent}|${info.emblemUrl}`;
      if (!w) {
        const g = document.createElementNS(NS, "g");
        g.setAttribute("class", "plot");
        w = { g, info };
        this.wings.set(info.schoolId, w);
      }
      this.plots.append(w.g); // re-append in depth order
      if (w.g.dataset.key !== key) {
        w.g.dataset.key = key;
        w.g.setAttribute("transform", `translate(${slot.x} ${slot.y}) scale(${slot.s})`);
        w.g.innerHTML =
          `<g class="build">${buildingMarkup(info.tier, info.accent, info.emblemUrl)}</g>` +
          `<g class="pin" transform="translate(0 ${-(TOP[info.tier] ?? 260)})"><path d="M0 0 q-24 -32 0 -56 q24 24 0 56z"/><circle cx="0" cy="-30" r="8"/></g>`;
      }
      w.info = info;
      if (grew) {
        w.g.classList.remove("grew");
        void w.g.getBoundingClientRect();
        w.g.classList.add("grew");
      }
    }
    this.flyTo(this.focused, true);
    return up;
  }

  /** Point at a School's building (or nothing). */
  flyTo(schoolId: string | null, force = false): void {
    if (schoolId === this.focused && !force) return;
    this.focused = schoolId;
    for (const [id, w] of this.wings) w.g.classList.toggle("focus", id === schoolId);
    this.el.classList.toggle("has-focus", !!schoolId && this.wings.has(schoolId));
  }

  /** Streak weather: clear when taught recently, clouds after a missed day, rain after three. */
  setFog(missedDays: number): void {
    const level = missedDays <= 1 ? 0 : missedDays < 3 ? 1 : 2;
    if (this.weather.dataset.level === String(level)) return;
    this.weather.dataset.level = String(level);
    this.weather.innerHTML = level
      ? `<rect class="haze" x="0" y="0" width="${W}" height="${H}" style="opacity:${level === 1 ? 0.18 : 0.32}"/>` +
        Array.from(
          { length: level === 1 ? 3 : 5 },
          (_, i) =>
            `<path class="raincloud" style="--i:${i}" d="M${760 + i * 170} ${120 + (i % 2) * 50} q16 -36 52 -24 q16 -32 56 -14 q36 -6 38 26 q24 4 20 28 h-160 q-22 -4 -6 -16z"/>`,
        ).join("") +
        (level === 2
          ? `<g class="rain">${Array.from({ length: 60 }, (_, i) => `<line x1="${700 + ((i * 97) % 900)}" y1="${200 + ((i * 53) % 600)}" x2="${690 + ((i * 97) % 900)}" y2="${224 + ((i * 53) % 600)}"/>`).join("")}</g>`
          : "")
      : "";
  }

  update(): void {}
  resize(): void {}

  dispose(): void {
    this.el.remove();
  }
}
