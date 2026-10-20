import * as Phaser from "phaser";
import { color, motion, reducedMotion, shape } from "../theme";

const SWEEP_MS = 2600;
const SWEEP_W = 12;

/** Thin 4px bar with a slow highlight sweep over the filled part (docs/08 §3). Value 0..1. */
export class Meter extends Phaser.GameObjects.Container {
  private readonly fill: Phaser.GameObjects.Graphics;
  private readonly sweep: Phaser.GameObjects.Graphics;
  private value = 0;
  private shown = 0;
  private readonly animate = !reducedMotion();

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    private readonly barWidth: number,
    private readonly tint: number = color.lumen,
  ) {
    super(scene, x, y);
    const track = scene.add.graphics();
    track.fillStyle(color.hull500, 1).fillRoundedRect(0, 0, barWidth, shape.meterHeight, 2);
    this.fill = scene.add.graphics();
    this.sweep = scene.add.graphics();
    this.add([track, this.fill, this.sweep]);
    this.setSize(barWidth, shape.meterHeight);
    this.draw();
    if (this.animate) {
      scene.events.on(Phaser.Scenes.Events.UPDATE, this.tick, this);
      this.once(Phaser.GameObjects.Events.DESTROY, () =>
        scene.events.off(Phaser.Scenes.Events.UPDATE, this.tick, this),
      );
    }
    scene.add.existing(this);
  }

  setValue(v: number): this {
    this.value = Math.min(1, Math.max(0, v));
    this.scene.tweens.add({
      targets: this,
      shown: this.value,
      duration: motion.panel,
      ease: motion.easeIn,
      onUpdate: () => this.draw(),
    });
    return this;
  }

  private tick(time: number) {
    const filled = this.barWidth * this.shown;
    this.sweep.clear();
    if (filled < SWEEP_W * 2) return;
    // Travel from just before the start to the end of the fill, clipped to it.
    const t = (time % SWEEP_MS) / SWEEP_MS;
    const x = -SWEEP_W + t * (filled + SWEEP_W);
    const from = Math.max(0, x);
    const to = Math.min(filled, x + SWEEP_W);
    if (to > from)
      this.sweep.fillStyle(0xffffff, 0.35).fillRect(from, 0, to - from, shape.meterHeight);
  }

  private draw() {
    this.fill.clear();
    this.fill
      .fillStyle(this.tint, 1)
      .fillRoundedRect(0, 0, Math.max(2, this.barWidth * this.shown), shape.meterHeight, 2);
  }
}
