import * as Phaser from "phaser";
import { ARCHETYPE_INFO, type HandView } from "@lumen/shared";
import { app } from "../../core/app";
import { elapsedMs, type ClassroomState } from "../../core/classroom";
import { pointer } from "../../core/input";
import { store, type AppState } from "../../core/store";
import { Button } from "../components/Button";
import { Meter } from "../components/Meter";
import { Panel } from "../components/Panel";
import { label } from "../components/text";
import { TimerRing } from "../components/TimerRing";
import { lectern } from "../dom/lectern";
import "../dom/cadetTag";
import "../dom/exitTickets";
import "../dom/rankUp";
import "../dom/speech";
import { transcript } from "../dom/transcript";
import { accentCss, accentOf, color, css, motion, uiScale } from "../theme";

// Classroom HUD (docs/02 §3.3). At most three regions show at once: top bar,
// hand queue, lectern. Roster and transcript are drawers (docs/08 §3).

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

export class ClassroomHud extends Phaser.Scene {
  private s = 1;
  private top?: Phaser.GameObjects.Container;
  private hands?: Phaser.GameObjects.Container;
  private roster?: Phaser.GameObjects.Container;
  private lecternFrame?: Panel;
  private hint?: Phaser.GameObjects.Text;
  private overlay?: Phaser.GameObjects.Container;
  private toasts?: Phaser.GameObjects.Container;
  private recap?: Phaser.GameObjects.Container;
  private conceptMenu?: Phaser.GameObjects.Container;
  private timer?: TimerRing;
  private xpBar?: Phaser.GameObjects.Container;
  private cost?: Phaser.GameObjects.Text;
  private rosterOpen = false;
  private unsubscribe?: () => void;

  constructor() {
    super("classroomHud");
  }

  create(): void {
    this.layout();
    this.scale.on(Phaser.Scale.Events.RESIZE, () => this.layout());
    this.unsubscribe = store.subscribe((st, prev) => this.onState(st, prev));
    // Pointer events no HUD object took go on into the 3D world (docs/05 §4.4).
    type Over = Phaser.GameObjects.GameObject[];
    this.input.on(Phaser.Input.Events.POINTER_MOVE, (p: Phaser.Input.Pointer, over: Over) =>
      over.length ? pointer.leave() : pointer.move(p.x, p.y, this.game.canvas),
    );
    this.input.on(Phaser.Input.Events.POINTER_DOWN, (p: Phaser.Input.Pointer, over: Over) => {
      if (over.length) return;
      if (this.conceptMenu) this.toggleConceptMenu(store.getState().classroom);
      pointer.click(p.x, p.y);
    });
    this.input.on(Phaser.Input.Events.GAME_OUT, () => pointer.leave());
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.unsubscribe?.();
      lectern.hide();
      transcript.toggle(false);
      pointer.leave();
    });
  }

  /** Full rebuild on resize; regions rebuild individually on state changes. */
  private layout() {
    const { width, height } = this.scale.gameSize;
    this.s = uiScale(width, height);
    const c = store.getState().classroom;
    this.buildTop(c);
    this.buildXp(c);
    this.buildHands(c);
    this.buildLectern();
    this.buildRoster(c);
    this.buildOverlay(c);
    this.buildToasts(c);
    this.buildRecap(c);
  }

  private onState(st: AppState, prev: AppState) {
    const c = st.classroom;
    const p = prev.classroom;
    if (
      c.concept !== p.concept ||
      c.school !== p.school ||
      c.cost.state !== p.cost.state ||
      st.net !== prev.net ||
      c.status !== p.status
    )
      this.buildTop(c);
    if (
      c.hands !== p.hands ||
      c.speech?.cadetId !== p.speech?.cadetId ||
      st.selectedId !== prev.selectedId
    )
      this.buildHands(c);
    if (c.cadets !== p.cadets) this.buildRoster(c);
    if (c.status !== p.status || c.ended !== p.ended || c.clock.paused !== p.clock.paused)
      this.buildOverlay(c);
    if (c.toasts !== p.toasts) this.buildToasts(c);
    if (c.recap !== p.recap) this.buildRecap(c);
    if (c.cost !== p.cost) this.cost?.setText(this.costText(c));
    if (c.xp !== p.xp) this.buildXp(c);
    if (c.xpGain && c.xpGain !== p.xpGain) this.flashXp(c.xpGain.delta, c.xpGain.reason);
  }

  override update(): void {
    const c = store.getState().classroom;
    if (this.timer && c.status === "live")
      this.timer.set(elapsedMs(c) / 1000, c.plannedMinutes * 60);
  }

  // --- top bar ----------------------------------------------------------------

  private costText(c: ClassroomState) {
    return `$${c.cost.periodUsd.toFixed(c.cost.periodUsd < 0.1 ? 4 : 2)}`;
  }

  private buildTop(c: ClassroomState) {
    this.top?.destroy();
    const s = this.s;
    const { width } = this.scale.gameSize;
    const g = (this.top = this.add.container(0, 0));
    const pad = 28 * s;
    g.add(
      label(
        this,
        pad,
        pad,
        [c.school?.name, c.classroom?.name].filter(Boolean).join(" · ") || "Lumen Academy",
        "micro",
        { scale: s },
      ),
    );
    const concept = label(
      this,
      pad,
      pad + 18 * s,
      `${c.concept?.title ?? "Connecting…"}  ▾`,
      "h2",
      { scale: s },
    );
    if (c.concepts.length > 1) {
      concept
        .setInteractive({ useHandCursor: true })
        .on("pointerdown", () => this.toggleConceptMenu(c));
    }
    g.add(concept);

    // Right: timer, this period's cost (tap for day/month), end class.
    const right = width - pad;
    this.timer = new TimerRing(this, right - 26 * s, pad + 22 * s, 24 * s, s * 0.8);
    g.add(this.timer);
    this.cost = label(this, right - 64 * s, pad + 6 * s, this.costText(c), "mono", {
      scale: s * 0.9,
    }).setOrigin(1, 0);
    const costLabel = label(
      this,
      right - 64 * s,
      pad + 28 * s,
      c.cost.state === "ok"
        ? "this class"
        : c.cost.state === "warn"
          ? "budget 80%"
          : c.cost.state === "degrade"
            ? "lighter models"
            : "paused",
      "micro",
      { scale: s, color: c.cost.state === "ok" ? css.inkDim : css.aurum },
    ).setOrigin(1, 0);
    this.cost.setInteractive({ useHandCursor: true }).on("pointerdown", () => {
      const k = store.getState().classroom.cost;
      app.notify(
        `Today $${k.dayUsd.toFixed(3)} · this month $${k.monthUsd.toFixed(2)} of $${k.capUsd}`,
      );
    });
    g.add([this.cost, costLabel]);
    if (c.status === "live")
      g.add(
        new Button(this, right - 220 * s, pad + 22 * s, "End class", {
          scale: s * 0.85,
          onClick: () => app.endClass(),
        }),
      );
    const net = store.getState().net;
    if (net === "connecting" || net === "closed")
      g.add(
        label(
          this,
          width / 2,
          pad,
          net === "connecting" ? "Connecting…" : "Reconnecting…",
          "caption",
          { scale: s, color: css.aurum },
        ).setOrigin(0.5, 0),
      );
  }

  private toggleConceptMenu(c: ClassroomState) {
    if (this.conceptMenu) {
      this.conceptMenu.destroy();
      this.conceptMenu = undefined;
      return;
    }
    const s = this.s;
    const rowH = 30 * s;
    const h = Math.min(c.concepts.length, 12) * rowH + 24 * s;
    const panel = new Panel(this, 28 * s, 76 * s, 380 * s, h);
    c.concepts.slice(0, 12).forEach((k, i) => {
      const t = label(this, 16 * s, 12 * s + i * rowH, k.title, "body", {
        scale: s * 0.9,
        color: k.id === c.concept?.id ? css.lumen : css.ink,
      });
      t.setInteractive({ useHandCursor: true }).on("pointerdown", () => {
        app.setConcept(k.id);
        this.toggleConceptMenu(c);
      });
      panel.add(t);
    });
    this.conceptMenu = panel;
  }

  // --- XP (docs/02 §3.3: top-right XP bar) ---------------------------------------

  /** Rank and progress to the next, left of End class. */
  private buildXp(c: ClassroomState) {
    this.xpBar?.destroy();
    this.xpBar = undefined;
    if (!c.xp) return;
    const s = this.s;
    const { width } = this.scale.gameSize;
    const w = 170 * s;
    const x = width - 28 * s - 290 * s - w;
    const g = (this.xpBar = this.add.container(x, 28 * s + 6 * s));
    // Rank on top, the bar, then progress left and total right.
    g.add(label(this, 0, 0, c.xp.rank, "micro", { scale: s }));
    const meter = new Meter(this, 0, 18 * s, w, color.aurum);
    meter.setValue(c.xp.progress);
    g.add(meter);
    if (c.xp.next)
      g.add(
        label(
          this,
          0,
          28 * s,
          `${(c.xp.next.minXp - c.xp.total).toLocaleString()} to ${c.xp.next.name}`,
          "caption",
          { scale: s * 0.8 },
        ),
      );
    g.add(
      label(this, w, 27 * s, `${c.xp.total.toLocaleString()} XP`, "mono", {
        scale: s * 0.7,
        color: css.aurum,
      }).setOrigin(1, 0),
    );
  }

  /** "+15 XP · Answered a question" rises from the XP bar and fades. */
  private flashXp(delta: number, reason: string) {
    if (!this.xpBar) return;
    const s = this.s;
    const t = label(
      this,
      this.xpBar.x,
      this.xpBar.y + 54 * s,
      `+${delta} XP · ${reason}`,
      "caption",
      {
        scale: s,
        color: css.aurum,
      },
    );
    this.tweens.add({
      targets: t,
      y: t.y - 14 * s,
      alpha: { from: 1, to: 0 },
      delay: 1400,
      duration: 900,
      ease: motion.easeOut,
      onComplete: () => t.destroy(),
    });
  }

  // --- hand queue ------------------------------------------------------------------

  private buildHands(c: ClassroomState) {
    this.hands?.destroy();
    const s = this.s;
    const { width } = this.scale.gameSize;
    const w = 340 * s;
    const x = width - w - 28 * s;
    const g = (this.hands = this.add.container(x, 110 * s));
    g.add(
      label(this, 0, 0, c.hands.length ? "Hands raised" : "No hands up", "micro", { scale: s }),
    );
    c.hands.slice(0, 5).forEach((h, i) => {
      const cadet = c.cadets[h.cadetId];
      if (!cadet) return;
      const y = 22 * s + i * 86 * s;
      const card = new Panel(this, 0, y, w, 76 * s);
      card.add(label(this, 14 * s, 12 * s, String(i + 1), "mono", { scale: s, color: css.lumen }));
      const dot = this.add.circle(42 * s, 22 * s, 4 * s, accentOf(cadet.archetype));
      card.add(dot);
      card.add(
        label(this, 54 * s, 12 * s, cadet.name.split(" ")[0]!, "body", {
          scale: s,
          color: accentCss(cadet.archetype),
        }),
      );
      card.add(
        label(
          this,
          54 * s + 0,
          32 * s,
          `${ARCHETYPE_INFO[cadet.archetype].label} · ${INTENT_LABEL[h.intent]}`,
          "caption",
          { scale: s * 0.9 },
        ),
      );
      card.add(
        label(this, 14 * s, 50 * s, `“${h.preview}”`, "caption", {
          scale: s * 0.95,
          color: css.ink,
          wrap: w - 28 * s,
        }).setLineSpacing(0),
      );
      card.setInteractive({
        hitArea: new Phaser.Geom.Rectangle(0, 0, w, 76 * s),
        hitAreaCallback: Phaser.Geom.Rectangle.Contains,
        useHandCursor: true,
      });
      const selected = h.cadetId === store.getState().selectedId;
      card.setFocused(selected);
      card
        .on("pointerover", () => card.setFocused(true))
        .on("pointerout", () => card.setFocused(selected));
      card.on("pointerdown", () => app.call(h.cadetId));
      card.setAlpha(0);
      this.tweens.add({ targets: card, alpha: 1, duration: motion.panel, delay: i * 40 });
      g.add(card);
    });
  }

  // --- lectern -----------------------------------------------------------------------

  private buildLectern() {
    const s = this.s;
    const { width, height } = this.scale.gameSize;
    const w = Math.min(880 * s, width - 2 * 400 * s);
    const h = 74 * s;
    const x = (width - w) / 2;
    const y = height - h - 46 * s;
    this.lecternFrame?.destroy();
    this.hint?.destroy();
    this.lecternFrame = new Panel(this, x, y, w, h).setFocused(
      document.activeElement === lectern.el,
    );
    lectern.place(x, y, w, h, s);
    lectern.el.onfocus = () => this.lecternFrame?.setFocused(true);
    lectern.el.onblur = () => this.lecternFrame?.setFocused(false);
    this.hint = label(
      this,
      width / 2,
      y + h + 12 * s,
      "Enter teach · Tab pick a hand · Space call · 1–5 call by number · R roster · ` transcript",
      "micro",
      { scale: s },
    ).setOrigin(0.5, 0);
  }

  // --- roster drawer -------------------------------------------------------------------

  get hasOpen(): boolean {
    return !!this.conceptMenu || this.rosterOpen;
  }

  /** Esc: close the concept menu, else the roster. */
  closeTop(): boolean {
    if (this.conceptMenu) this.toggleConceptMenu(store.getState().classroom);
    else if (this.rosterOpen) this.toggleRoster();
    else return false;
    return true;
  }

  toggleRoster() {
    this.rosterOpen = !this.rosterOpen;
    this.buildRoster(store.getState().classroom);
  }

  private buildRoster(c: ClassroomState) {
    this.roster?.destroy();
    this.roster = undefined;
    if (!this.rosterOpen) return;
    const s = this.s;
    const cadets = Object.values(c.cadets).sort((a, b) => a.seat - b.seat);
    const rowH = 34 * s;
    const panel = new Panel(this, 28 * s, 110 * s, 300 * s, 40 * s + cadets.length * rowH);
    panel.add(
      label(
        this,
        16 * s,
        14 * s,
        `Roster · understanding of ${c.concept?.title ?? ""}`.slice(0, 44),
        "micro",
        { scale: s },
      ),
    );
    cadets.forEach((cadet, i) => {
      const y = 38 * s + i * rowH;
      panel.add(this.add.circle(20 * s, y + 9 * s, 4 * s, accentOf(cadet.archetype)));
      panel.add(
        label(this, 32 * s, y, cadet.name.split(" ")[0]!, "caption", { scale: s, color: css.ink }),
      );
      panel.add(
        new Meter(this, 120 * s, y + 7 * s, 120 * s, accentOf(cadet.archetype)).setValue(
          cadet.comprehension,
        ),
      );
      panel.add(
        label(this, 252 * s, y, `${Math.round(cadet.comprehension * 100)}%`, "monoSmall", {
          scale: s,
        }),
      );
    });
    this.roster = panel;
  }

  // --- overlays: starting, bell-out --------------------------------------------------------

  private buildOverlay(c: ClassroomState) {
    this.overlay?.destroy();
    this.overlay = undefined;
    const s = this.s;
    const { width, height } = this.scale.gameSize;
    if (c.status === "starting") {
      this.overlay = this.add.container(width / 2, height / 2, [
        label(this, 0, 0, "Cadets are taking their seats…", "h2", { scale: s }).setOrigin(0.5),
      ]);
      return;
    }
    if (c.status === "ending") {
      this.overlay = this.add.container(width / 2, height / 2, [
        label(this, 0, 0, "Ringing the bell…", "h2", { scale: s }).setOrigin(0.5),
      ]);
      return;
    }
    if (c.status === "live" && c.clock.paused) return this.buildPause(c);
    if (c.status !== "ended" || !c.ended) return;
    const w = 560 * s;
    const recap = c.ended.recapOut ?? "";
    const panel = new Panel(this, (width - w) / 2, height * 0.22, w, 0).setSolid();
    panel.add(label(this, 28 * s, 26 * s, "Class dismissed", "micro", { scale: s }));
    panel.add(label(this, 28 * s, 48 * s, "🔔 That's the bell.", "h1", { scale: s }));
    panel.add(
      label(
        this,
        28 * s,
        96 * s,
        `${c.ended.turns} turns · ${c.ended.minutes} min · $${c.ended.costUsd.toFixed(4)}`,
        "mono",
        { scale: s * 0.85, color: css.inkDim },
      ),
    );
    // XP tally: the number, what earned it, and a rank-up if there was one.
    const xp = c.ended.xp;
    panel.add(
      label(this, 28 * s, 124 * s, `+${xp.earned} XP`, "h2", { scale: s, color: css.aurum }),
    );
    panel.add(
      label(
        this,
        28 * s,
        154 * s,
        xp.breakdown.length
          ? xp.breakdown.map((b) => `${XP_LABEL[b.kind] ?? b.kind} ${b.amount}`).join(" · ")
          : "Teach a full minute or answer a question to earn XP.",
        "caption",
        { scale: s, wrap: w - 56 * s },
      ),
    );
    panel.add(
      label(
        this,
        w - 28 * s,
        128 * s,
        xp.rankedUp ? `New rank: ${xp.standing.rank}` : xp.standing.rank,
        xp.rankedUp ? "body" : "caption",
        { scale: s, color: xp.rankedUp ? css.lumen : css.inkDim },
      ).setOrigin(1, 0),
    );
    const body = label(
      this,
      28 * s,
      190 * s,
      recap ? `Next time…\n${recap.replace(/\*\*/g, "")}` : "",
      "body",
      { scale: s * 0.95, wrap: w - 56 * s },
    );
    panel.add(body);
    const btnY = 190 * s + body.height + 36 * s;
    const back = new Button(this, 0, btnY, "Back to classes", {
      primary: true,
      scale: s,
      onClick: () => app.backToBoot(),
    });
    back.setX(w - 28 * s - back.width / 2);
    panel.add(back);
    // Straight to the Class Desk: homework on what was just taught.
    const school = c.school?.id;
    const room = c.classroom?.id;
    if (school && room) {
      const desk = new Button(this, 0, btnY, "Set homework", {
        scale: s,
        onClick: () => app.openDesk(school, room, "assignments"),
      });
      desk.setX(back.x - back.width / 2 - 12 * s - desk.width / 2);
      panel.add(desk);
    }
    panel.resize(w, btnY + 40 * s);
    this.overlay = this.add.container(0, 0, [this.backdrop(), panel]);
  }

  /** Dims the room behind a modal card (not black: the class is still there) and swallows clicks. */
  private backdrop() {
    const { width, height } = this.scale.gameSize;
    return this.add.rectangle(0, 0, width, height, color.void, 0.6).setOrigin(0).setInteractive();
  }

  /** Esc pauses: the class waits, the clock stops. A resumed period opens here too. */
  private buildPause(c: ClassroomState) {
    const s = this.s;
    const { width, height } = this.scale.gameSize;
    const w = 480 * s;
    const h = 186 * s;
    const left = Math.max(0, c.plannedMinutes - Math.floor(elapsedMs(c) / 60_000));
    const g = this.add.container(0, 0);
    const dim = this.backdrop();
    const panel = new Panel(this, (width - w) / 2, (height - h) / 2, w, h).setSolid();
    panel.add(
      label(this, 28 * s, 26 * s, c.resumed ? "Welcome back" : "Paused", "micro", { scale: s }),
    );
    panel.add(
      label(
        this,
        28 * s,
        48 * s,
        c.resumed
          ? `${c.classroom?.name ?? "Your class"} kept your seat.`
          : "The class is waiting.",
        "h1",
        { scale: s },
      ),
    );
    panel.add(
      label(this, 28 * s, 96 * s, `${left} min left in this period`, "mono", {
        scale: s * 0.85,
        color: css.aurum,
      }),
    );
    // Buttons are centre-anchored: lay them out left to right by width.
    const resume = new Button(this, 0, 0, "Resume", {
      primary: true,
      scale: s,
      onClick: () => app.resume(),
    });
    const end = new Button(this, 0, 0, "End class", { scale: s, onClick: () => app.endClass() });
    const rowY = h - 44 * s;
    resume.setPosition(28 * s + resume.width / 2, rowY);
    end.setPosition(resume.x + resume.width / 2 + 12 * s + end.width / 2, rowY);
    panel.add([resume, end]);
    panel.add(
      label(this, w - 28 * s, rowY, "Esc or Space to resume", "caption", { scale: s }).setOrigin(
        1,
        0.5,
      ),
    );
    g.add([dim, panel]);
    this.overlay = g;
  }

  // --- toasts and recap card -------------------------------------------------------------

  private buildToasts(c: ClassroomState) {
    this.toasts?.destroy();
    const s = this.s;
    const { width } = this.scale.gameSize;
    const g = (this.toasts = this.add.container(width / 2, 78 * s));
    c.toasts.forEach((t, i) => {
      const text = label(this, 0, i * 34 * s, t.text, "caption", {
        scale: s,
        color: t.level === "info" ? css.ink : css.aurum,
      }).setOrigin(0.5, 0);
      const bg = this.add
        .rectangle(
          0,
          i * 34 * s - 6 * s,
          text.width + 28 * s,
          text.height + 12 * s,
          color.hull900,
          0.85,
        )
        .setOrigin(0.5, 0)
        .setStrokeStyle(1, t.level === "info" ? color.hull500 : color.aurum);
      g.add([bg, text]);
    });
  }

  private buildRecap(c: ClassroomState) {
    this.recap?.destroy();
    this.recap = undefined;
    if (!c.recap || c.status !== "live") return;
    const s = this.s;
    const { height } = this.scale.gameSize;
    const w = 360 * s;
    const body = label(this, 16 * s, 34 * s, c.recap.replace(/\*\*/g, ""), "caption", {
      scale: s,
      color: css.ink,
      wrap: w - 32 * s,
    });
    const panel = new Panel(this, 28 * s, height - body.height - 200 * s, w, body.height + 52 * s);
    panel.add([label(this, 16 * s, 14 * s, "Last time…", "micro", { scale: s }), body]);
    this.recap = panel;
    // It's a reminder, not a wall: fade after a while (ADHD rule 5).
    this.time.delayedCall(14000, () =>
      this.tweens.add({
        targets: panel,
        alpha: 0,
        duration: motion.panel,
        onComplete: () => panel.destroy(),
      }),
    );
  }
}
