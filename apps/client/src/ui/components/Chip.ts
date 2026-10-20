import * as Phaser from "phaser";
import { alpha, color, shape } from "../theme";
import { label } from "./text";

/** Pill, 24px tall, accent dot on the left (docs/08 §3). */
export class Chip extends Phaser.GameObjects.Container {
  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    text: string,
    accent: number,
    opts: { scale?: number } = {},
  ) {
    super(scene, x, y);
    const s = opts.scale ?? 1;
    const h = Math.round(shape.chipHeight * s);
    const t = label(scene, h * 0.9, h / 2, text, "caption", {
      color: "#E6EDF7",
      scale: s,
    }).setOrigin(0, 0.5);
    const w = t.x + t.width + h * 0.5;
    const g = scene.add.graphics();
    g.fillStyle(color.hull700, alpha.panelBase);
    g.fillRoundedRect(0, 0, w, h, h / 2);
    g.lineStyle(1, color.hull500, 1);
    g.strokeRoundedRect(0.5, 0.5, w - 1, h - 1, h / 2);
    g.fillStyle(accent, 1);
    g.fillCircle(h / 2, h / 2, 4 * s);
    this.add([g, t]);
    this.setSize(w, h);
    scene.add.existing(this);
  }
}
