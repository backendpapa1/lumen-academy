import * as Phaser from "phaser";
import { ARCHETYPES, ARCHETYPE_INFO } from "@lumen/shared";
import { Button } from "../components/Button";
import { Chip } from "../components/Chip";
import { Meter } from "../components/Meter";
import { Panel } from "../components/Panel";
import { label } from "../components/text";
import { TimerRing } from "../components/TimerRing";
import { accentOf, css, uiScale } from "../theme";

/** ?view=gallery — every HUD component in its states, for visual review (M2-02). */
export class GalleryScene extends Phaser.Scene {
  constructor() {
    super("gallery");
  }

  create(): void {
    const { width, height } = this.scale.gameSize;
    const s = uiScale(width, height);
    const x0 = 48 * s;
    let y = 40 * s;
    label(this, x0, y, "Lumen Academy · HUD components", "micro", { scale: s });
    y += 24 * s;
    label(this, x0, y, "Merkle Trees", "display", { scale: s });
    y += 56 * s;
    label(this, x0, y, "H1 heading — Class A", "h1", { scale: s });
    label(this, x0 + 360 * s, y + 8 * s, "12:47  $0.0035  +120 XP", "mono", {
      scale: s,
      color: css.aurum,
    });
    y += 44 * s;
    label(
      this,
      x0,
      y,
      "Body: “If one transaction changes, its hash changes, and every parent hash up to the root changes too.”",
      "body",
      { scale: s, wrap: 760 * s },
    );
    y += 64 * s;

    const p1 = new Panel(this, x0, y, 360 * s, 150 * s);
    p1.add(label(this, 16 * s, 14 * s, "Panel · default", "micro", { scale: s }));
    p1.add(
      label(this, 16 * s, 40 * s, "Glass over a dark base,\nchamfered top-right corner.", "body", {
        scale: s,
      }),
    );
    const p2 = new Panel(this, x0 + 384 * s, y, 360 * s, 150 * s).setFocused(true);
    p2.add(label(this, 16 * s, 14 * s, "Panel · focused", "micro", { scale: s }));
    p2.add(
      label(
        this,
        16 * s,
        40 * s,
        "Lumen border and the one\nstrong glow allowed in view.",
        "body",
        { scale: s },
      ),
    );
    y += 176 * s;

    new Button(this, x0 + 70 * s, y + 18 * s, "Call on Ines", { scale: s });
    new Button(this, x0 + 230 * s, y + 18 * s, "Start class", { primary: true, scale: s });
    new TimerRing(this, x0 + 420 * s, y + 18 * s, 28 * s, s).set(8 * 60 + 13, 15 * 60);
    new TimerRing(this, x0 + 500 * s, y + 18 * s, 28 * s, s).set(16 * 60, 15 * 60);
    y += 70 * s;

    let cx = x0;
    ARCHETYPES.forEach((a) => {
      const chip = new Chip(this, cx, y, ARCHETYPE_INFO[a].label, accentOf(a), { scale: s });
      cx += chip.width + 8 * s;
    });
    y += 48 * s;

    [0.12, 0.48, 0.81].forEach((v, i) => {
      label(this, x0, y + i * 26 * s - 6 * s, `${Math.round(v * 100)}%`, "monoSmall", { scale: s });
      new Meter(this, x0 + 56 * s, y + i * 26 * s, 300 * s).setValue(v);
    });
  }
}
