import * as Phaser from "phaser";
import { color, css } from "../theme";
import { label } from "./text";

/** Period timer ring (docs/02 §3.3): fills clockwise; mono minutes in the middle. */
export class TimerRing extends Phaser.GameObjects.Container {
  private readonly ring: Phaser.GameObjects.Graphics;
  private readonly text: Phaser.GameObjects.Text;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    private readonly radius: number,
    scale = 1,
  ) {
    super(scene, x, y);
    this.ring = scene.add.graphics();
    this.text = label(scene, 0, 0, "15:00", "mono", { scale }).setOrigin(0.5);
    this.add([this.ring, this.text]);
    this.setSize(radius * 2, radius * 2);
    this.set(0, 15 * 60);
    scene.add.existing(this);
  }

  /** elapsed / total in seconds. Past the bell the ring turns aurum (a reward, not an alarm). */
  set(elapsed: number, total: number): this {
    const left = Math.max(0, total - elapsed);
    const over = elapsed >= total;
    const mm = Math.floor(left / 60);
    const ss = Math.floor(left % 60);
    this.text
      .setText(over ? "bell" : `${mm}:${String(ss).padStart(2, "0")}`)
      .setColor(over ? css.aurum : css.ink);
    const g = this.ring;
    g.clear();
    g.lineStyle(3, color.hull500, 1).strokeCircle(0, 0, this.radius);
    const p = Math.min(1, elapsed / total);
    if (p > 0) {
      g.lineStyle(3, over ? color.aurum : color.lumen, 1);
      g.beginPath();
      g.arc(0, 0, this.radius, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
      g.strokePath();
    }
    return this;
  }
}
