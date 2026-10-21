import { ARCHETYPE_INFO, type HandView } from "@lumen/shared";
import { app } from "../../core/app";
import { elapsedMs, type ClassroomState } from "../../core/classroom";
import { store, type AppState } from "../../core/store";
import "../dom/cadetTag";
import "../dom/exitTickets";
import "../dom/events";
import "../dom/rankUp";
import "../dom/speech";
import { lectern, talk } from "../dom/lectern";
import { voice } from "../../core/voice";
import { transcript } from "../dom/transcript";
import { lookFor, peepSvg, restingFace } from "../peeps/peep";
import { fill, h, icon, ICONS } from "../screens/dom";
import "./hud.css";

// The classroom HUD (docs/02 §3.3, ADR-009), in the DOM over the drawn room.
// At most three regions show at once: top bar, hands up, lectern. Roster and
// transcript are drawers; pause, bell and dismissal are cards.

const INTENT_LABEL: Record<HandView["intent"], string> = {
  clarify: "wants to clarify",
  challenge: "challenges you",
  example: "wants an example",
  connect: "sees a connection",
  eli10: "wants it simpler",
  deeper: "wants to go deeper",
  wrong_claim: "has a claim",
};

const XP_LABEL: Record<string, string> = {
  teachingMinute: "teaching",
  questionAnswered: "questions answered",
  misconceptionCorrected: "misconceptions fixed",
};

const first = (name: string) => name.split(" ")[0]!;
const money = (usd: number) => `$${usd.toFixed(usd < 0.1 ? 4 : 2)}`;

/** A small head-and-shoulders of a student, for cards and lists. */
export function face(id: string, archetype: Parameters<typeof restingFace>[0], size = 44) {
  const el = h("span", { class: "peep-face", style: `--s:${size}px`, "aria-hidden": "true" });
  el.innerHTML = peepSvg(lookFor(id), { face: restingFace(archetype) });
  return el;
}

export class ClassroomHud {
  readonly el = h("div", { class: "hud" });
  private readonly top = h("header", { class: "hud-top" });
  private readonly hands = h("section", { class: "hud-hands", "aria-label": "Hands up" });
  private readonly bottom = h("div", { class: "hud-bottom" });
  private readonly roster = h("aside", { class: "hud-roster card", "aria-label": "Roster" });
  private readonly overlay = h("div", { class: "hud-overlay" });
  private readonly toasts = h("div", { class: "hud-toasts", "aria-live": "polite" });
  private readonly recap = h("aside", { class: "hud-recap card" });
  private readonly timer = h("div", { class: "timer mono" });
  private readonly xpFloat = h("div", { class: "xp-float", "aria-hidden": "true" });
  private conceptMenu: HTMLElement | null = null;
  private rosterOpen = false;
  private bellRangFor: number | null = null;
  private bellAnswered = false;
  private recapTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly unsubscribe: () => void;
  private readonly interval: ReturnType<typeof setInterval>;
  private readonly onKey = (e: KeyboardEvent) => this.bellKeys(e);
  private offVoice: (() => void) | null = null;

  constructor(stage: HTMLElement) {
    this.roster.hidden = true;
    this.recap.hidden = true;
    this.el.append(
      this.top,
      this.hands,
      this.bottom,
      this.roster,
      this.toasts,
      this.recap,
      this.overlay,
    );
    stage.append(this.el);
    this.buildBottom();
    const c = store.getState().classroom;
    this.buildTop(c);
    this.buildHands(c, store.getState().selectedId);
    this.buildOverlay(c);
    this.buildToasts(c);
    this.buildRecap(c);
    this.unsubscribe = store.subscribe((s, p) => this.onState(s, p));
    this.interval = setInterval(() => this.everySecond(), 250);
    window.addEventListener("keydown", this.onKey, { capture: true });
  }

  private onState(st: AppState, prev: AppState) {
    const c = st.classroom;
    const p = prev.classroom;
    if (
      c.concept !== p.concept ||
      c.concepts !== p.concepts ||
      c.school !== p.school ||
      c.cost !== p.cost ||
      c.xp !== p.xp ||
      c.hyperfocus !== p.hyperfocus ||
      st.net !== prev.net ||
      c.status !== p.status
    )
      this.buildTop(c);
    if (
      c.hands !== p.hands ||
      c.speech?.cadetId !== p.speech?.cadetId ||
      st.selectedId !== prev.selectedId
    )
      this.buildHands(c, st.selectedId);
    if (this.rosterOpen && c.cadets !== p.cadets) this.buildRoster(c);
    if (
      c.status !== p.status ||
      c.ended !== p.ended ||
      c.clock.paused !== p.clock.paused ||
      c.resumed !== p.resumed
    )
      this.buildOverlay(c);
    if (c.toasts !== p.toasts) this.buildToasts(c);
    if (c.recap !== p.recap || c.status !== p.status) this.buildRecap(c);
    if (c.xpGain && c.xpGain !== p.xpGain) this.flashXp(c.xpGain.delta, c.xpGain.reason);
  }

  // --- top bar ---------------------------------------------------------------

  private buildTop(c: ClassroomState) {
    const net = store.getState().net;
    const concept = h(
      "button",
      {
        class: "concept",
        "aria-haspopup": "menu",
        "aria-expanded": String(!!this.conceptMenu),
        disabled: c.concepts.length < 2,
        onclick: (e: Event) => {
          e.stopPropagation();
          this.toggleConceptMenu();
        },
      },
      c.concept?.title ?? "Connecting…",
      c.concepts.length > 1 ? h("span", { class: "caret", "aria-hidden": "true" }, "▾") : null,
    );
    const left = h(
      "div",
      { class: "hud-title" },
      h(
        "div",
        { class: "micro" },
        [c.school?.name, c.classroom?.name].filter(Boolean).join(" · ") || "Lumen Academy",
        c.hyperfocus ? h("span", { class: "chip focus" }, "Hyperfocus") : null,
      ),
      concept,
    );
    const xp = c.xp;
    const rank = xp
      ? h(
          "div",
          { class: "hud-xp" },
          h("div", { class: "micro" }, xp.rank),
          h("div", { class: "bar" }, h("i", { style: `width:${Math.round(xp.progress * 100)}%` })),
          h(
            "div",
            { class: "xp-line" },
            h(
              "span",
              {},
              xp.next
                ? `${(xp.next.minXp - xp.total).toLocaleString()} to ${xp.next.name}`
                : "Top rank",
            ),
            h("b", {}, `${xp.total.toLocaleString()} XP`),
          ),
          this.xpFloat,
        )
      : null;
    const k = c.cost;
    const cost = h(
      "button",
      {
        class: `cost ${k.state}`,
        title: "What today and this month cost",
        onclick: () =>
          app.notify(
            `Today $${k.dayUsd.toFixed(3)} · this month $${k.monthUsd.toFixed(2)} of $${k.capUsd}`,
          ),
      },
      h("b", {}, money(k.periodUsd)),
      h(
        "span",
        {},
        k.state === "ok"
          ? "this class"
          : k.state === "warn"
            ? "budget 80%"
            : k.state === "degrade"
              ? "lighter models"
              : "paused",
      ),
    );
    fill(
      this.top,
      left,
      net === "connecting" || net === "closed"
        ? h("div", { class: "chip net" }, net === "connecting" ? "Connecting…" : "Reconnecting…")
        : h("span", { class: "spacer" }),
      h(
        "div",
        { class: "hud-right" },
        rank,
        cost,
        this.timer,
        c.status === "live"
          ? h("button", { class: "btn", onclick: () => app.endClass() }, "End class")
          : null,
      ),
    );
    this.everySecond();
  }

  private toggleConceptMenu() {
    if (this.conceptMenu) {
      this.conceptMenu.remove();
      this.conceptMenu = null;
      return;
    }
    const c = store.getState().classroom;
    const menu = h(
      "div",
      { class: "concept-menu card", role: "menu" },
      ...c.concepts.slice(0, 14).map((k) =>
        h(
          "button",
          {
            role: "menuitem",
            class: k.id === c.concept?.id ? "current" : "",
            onclick: () => {
              app.setConcept(k.id);
              this.toggleConceptMenu();
            },
          },
          k.title,
        ),
      ),
    );
    this.conceptMenu = menu;
    this.top.append(menu);
    menu.querySelector<HTMLElement>("button")?.focus();
    const away = (e: Event) => {
      if (!menu.contains(e.target as Node)) {
        if (this.conceptMenu === menu) this.toggleConceptMenu();
        document.removeEventListener("pointerdown", away, true);
      }
    };
    document.addEventListener("pointerdown", away, true);
  }

  /** The clock (time left, then "bell"), and the bell itself at the planned time. */
  private everySecond() {
    const c = store.getState().classroom;
    const total = c.plannedMinutes * 60;
    const elapsed = elapsedMs(c) / 1000;
    const left = Math.max(0, total - elapsed);
    const over = c.status === "live" && elapsed >= total;
    this.timer.textContent = over
      ? "bell"
      : `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, "0")}`;
    this.timer.classList.toggle("over", over);
    this.timer.style.setProperty("--p", String(Math.min(1, elapsed / Math.max(1, total))));
    // Ask at the planned time (never auto-end): end class, or 5 more minutes.
    if (over && !c.clock.paused && this.bellRangFor !== c.plannedMinutes) {
      this.bellRangFor = c.plannedMinutes;
      this.bellAnswered = false;
      this.buildOverlay(c);
    }
  }

  private bellDue(c: ClassroomState) {
    return (
      c.status === "live" &&
      this.bellRangFor === c.plannedMinutes &&
      elapsedMs(c) >= c.plannedMinutes * 60_000
    );
  }

  // --- XP --------------------------------------------------------------------

  private flashXp(delta: number, reason: string) {
    this.xpFloat.textContent = `+${delta} XP · ${reason}`;
    this.xpFloat.classList.remove("go");
    void this.xpFloat.offsetWidth;
    this.xpFloat.classList.add("go");
  }

  // --- hands up --------------------------------------------------------------

  private buildHands(c: ClassroomState, selected: string | null) {
    const speaking = c.speech?.cadetId;
    const cards = c.hands.slice(0, 5).flatMap((hand, i) => {
      const s = c.cadets[hand.cadetId];
      if (!s) return [];
      return [
        h(
          "button",
          {
            class: `hand-card card${hand.cadetId === selected ? " selected" : ""}${hand.cadetId === speaking ? " speaking" : ""}`,
            style: `--i:${i}`,
            "aria-label": `Call on ${s.name} (${i + 1}): ${hand.preview}`,
            onclick: () => app.call(hand.cadetId),
            onmouseenter: () => store.setState({ hoveredId: hand.cadetId }),
            onmouseleave: () => store.setState({ hoveredId: null }),
          },
          h("span", { class: "num" }, String(i + 1)),
          face(s.id, s.archetype, 46),
          h(
            "span",
            { class: "who" },
            h("b", {}, first(s.name)),
            h("small", {}, `${ARCHETYPE_INFO[s.archetype].label} · ${INTENT_LABEL[hand.intent]}`),
          ),
          h("q", {}, hand.preview),
        ),
      ];
    });
    fill(
      this.hands,
      h("div", { class: "micro" }, c.hands.length ? "Hands up" : "No hands up"),
      ...cards,
    );
  }

  // --- lectern ---------------------------------------------------------------

  private buildBottom() {
    lectern.el.style.cssText = "";
    lectern.el.classList.add("in-hud");
    const send = h(
      "button",
      {
        class: "btn primary teach",
        onclick: () => {
          app.teach(lectern.el.value);
          lectern.el.value = "";
          lectern.focus();
        },
      },
      "Teach",
      h("kbd", {}, "⏎"),
    );
    const mic = h(
      "button",
      {
        class: "mic",
        title: "Talk to the class (or hold Space in the empty lectern)",
        "aria-label": "Talk to the class",
        onclick: () => talk.toggle(),
      },
      icon(ICONS.mic),
      h("span", { class: "level", "aria-hidden": "true" }),
    );
    const syncMic = () => {
      mic.hidden = !voice.canListen;
      mic.classList.toggle("on", voice.state.recording);
      mic.setAttribute("aria-pressed", String(voice.state.recording));
    };
    syncMic();
    this.offVoice = voice.on(syncMic);
    fill(
      this.bottom,
      h("div", { class: "lectern card" }, mic, lectern.el, send),
      h(
        "div",
        { class: "hints" },
        ...[
          ["Enter", "teach"],
          ["Space", "call a hand · hold to talk"],
          ["Tab", "pick a hand"],
          ["1–5", "call by number"],
          ["R", "roster"],
          ["`", "transcript"],
          ["Esc", "pause"],
        ].map(([k, t]) => h("span", {}, h("kbd", {}, k!), t!)),
      ),
    );
  }

  // --- roster drawer -----------------------------------------------------------

  get hasOpen(): boolean {
    return !!this.conceptMenu || this.rosterOpen;
  }

  closeTop(): boolean {
    if (this.conceptMenu) this.toggleConceptMenu();
    else if (this.rosterOpen) this.toggleRoster();
    else return false;
    return true;
  }

  toggleRoster() {
    this.rosterOpen = !this.rosterOpen;
    this.roster.hidden = !this.rosterOpen;
    if (this.rosterOpen) this.buildRoster(store.getState().classroom);
  }

  private buildRoster(c: ClassroomState) {
    const students = Object.values(c.cadets).sort((a, b) => a.seat - b.seat);
    fill(
      this.roster,
      h(
        "div",
        { class: "roster-head" },
        h("div", { class: "micro" }, "Roster"),
        h("div", { class: "dim" }, `Understanding of ${c.concept?.title ?? "this concept"}`),
      ),
      h(
        "ol",
        {},
        ...students.map((s) => {
          const pct = Math.round(s.comprehension * 100);
          return h(
            "li",
            {},
            face(s.id, s.archetype, 34),
            h(
              "span",
              { class: "who" },
              h("b", {}, s.name),
              h("small", {}, ARCHETYPE_INFO[s.archetype].label),
            ),
            h("span", { class: "bar" }, h("i", { style: `width:${pct}%` })),
            h("span", { class: "pct mono" }, `${pct}%`),
          );
        }),
      ),
    );
  }

  // --- overlays: starting, pause, bell, dismissed ---------------------------------

  private buildOverlay(c: ClassroomState) {
    let card: HTMLElement | null = null;
    if (c.status === "starting") card = this.note("Your students are taking their seats…");
    else if (c.status === "ending") card = this.note("Ringing the bell…");
    else if (c.status === "live" && c.clock.paused) card = this.pauseCard(c);
    else if (this.bellDue(c) && !this.bellAnswered) card = this.bellCard(c);
    else if (c.status === "ended" && c.ended) card = this.endedCard(c);
    this.overlay.classList.toggle("shown", !!card);
    this.overlay.classList.toggle("blocking", !!card && !card.classList.contains("note"));
    fill(this.overlay, card);
    card?.querySelector<HTMLElement>(".btn.primary")?.focus({ preventScroll: true });
  }

  private note(text: string) {
    return h("div", { class: "note card", role: "status" }, h("span", { class: "spinner" }), text);
  }

  private pauseCard(c: ClassroomState) {
    const left = Math.max(0, c.plannedMinutes - Math.floor(elapsedMs(c) / 60_000));
    return h(
      "section",
      { class: "dialog card", role: "dialog", "aria-label": c.resumed ? "Welcome back" : "Paused" },
      h("div", { class: "micro" }, c.resumed ? "Welcome back" : "Paused"),
      h(
        "h2",
        { class: "h1" },
        c.resumed
          ? `${c.classroom?.name ?? "Your class"} kept your seat.`
          : "The class is waiting.",
      ),
      h("p", { class: "mono gold" }, `${left} min left in this period`),
      h(
        "div",
        { class: "actions" },
        h("button", { class: "btn primary", onclick: () => app.resume() }, "Resume"),
        h("button", { class: "btn", onclick: () => app.endClass() }, "End class"),
        h("span", { class: "spacer" }),
        h("span", { class: "dim small" }, "Esc or Space to resume"),
      ),
    );
  }

  private bellCard(c: ClassroomState) {
    return h(
      "section",
      { class: "dialog card bell", role: "dialog", "aria-label": "The bell" },
      h("div", { class: "bell-art", "aria-hidden": "true" }, "🔔"),
      h("div", { class: "micro" }, "The bell"),
      h("h2", { class: "h1" }, `That's ${c.plannedMinutes} minutes.`),
      h("p", { class: "dim" }, "Enter ends class · E for 5 more minutes"),
      h(
        "div",
        { class: "actions" },
        h("button", { class: "btn primary", onclick: () => this.answerBell(false) }, "End class"),
        h("button", { class: "btn", onclick: () => this.answerBell(true) }, "5 more minutes"),
      ),
    );
  }

  private answerBell(extend: boolean) {
    this.bellAnswered = true;
    if (extend) app.extend(5);
    else app.endClass();
    this.buildOverlay(store.getState().classroom);
  }

  private bellKeys(e: KeyboardEvent) {
    if (!this.bellDue(store.getState().classroom) || this.bellAnswered) return;
    if (e.key === "Enter") this.answerBell(false);
    else if (e.key.toLowerCase() === "e") this.answerBell(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  private endedCard(c: ClassroomState) {
    const e = c.ended!;
    const xp = e.xp;
    const recap = (e.recapOut ?? "").replace(/\*\*/g, "");
    const school = c.school?.id;
    const room = c.classroom?.id;
    return h(
      "section",
      { class: "dialog card ended", role: "dialog", "aria-label": "Class dismissed" },
      h("div", { class: "micro" }, "Class dismissed"),
      h("h2", { class: "extrude big" }, "That's the bell!"),
      h(
        "p",
        { class: "mono dim" },
        `${e.turns} turns · ${e.minutes} min · $${e.costUsd.toFixed(4)}`,
      ),
      h(
        "div",
        { class: "xp-tally" },
        h("b", {}, `+${xp.earned} XP`),
        h(
          "span",
          {},
          xp.breakdown.length
            ? xp.breakdown.map((b) => `${XP_LABEL[b.kind] ?? b.kind} ${b.amount}`).join(" · ")
            : "Teach a full minute or answer a question to earn XP.",
        ),
        h(
          "span",
          { class: xp.rankedUp ? "chip gold" : "chip" },
          xp.rankedUp ? `New rank: ${xp.standing.rank}` : xp.standing.rank,
        ),
      ),
      recap
        ? h("div", { class: "next" }, h("div", { class: "micro" }, "Next time…"), h("p", {}, recap))
        : null,
      h(
        "div",
        { class: "actions" },
        h("span", { class: "spacer" }),
        school && room
          ? h(
              "button",
              { class: "btn", onclick: () => app.openDesk(school, room, "assignments") },
              "Set homework",
            )
          : null,
        h("button", { class: "btn primary", onclick: () => app.backToBoot() }, "Back to classes"),
      ),
    );
  }

  // --- toasts and the recap card -----------------------------------------------------

  private buildToasts(c: ClassroomState) {
    fill(
      this.toasts,
      ...c.toasts.map((t) =>
        h("div", { class: `toast card ${t.level}`, "data-id": String(t.id) }, t.text),
      ),
    );
  }

  private buildRecap(c: ClassroomState) {
    if (this.recapTimer) clearTimeout(this.recapTimer);
    const show = !!c.recap && c.status === "live";
    this.recap.hidden = !show;
    this.recap.classList.remove("fade");
    if (!show) return;
    fill(
      this.recap,
      h("div", { class: "micro" }, "Last time…"),
      h("p", {}, c.recap!.replace(/\*\*/g, "")),
    );
    // A reminder, not a wall: it fades after a while (ADHD rule 5).
    this.recapTimer = setTimeout(() => this.recap.classList.add("fade"), 14000);
  }

  dispose() {
    this.unsubscribe();
    this.offVoice?.();
    clearInterval(this.interval);
    if (this.recapTimer) clearTimeout(this.recapTimer);
    window.removeEventListener("keydown", this.onKey, { capture: true });
    lectern.el.classList.remove("in-hud");
    document.querySelector("#stage")!.append(lectern.el);
    lectern.hide();
    transcript.toggle(false);
    this.el.remove();
  }
}
