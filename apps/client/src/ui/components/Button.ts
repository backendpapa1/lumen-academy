import * as Phaser from "phaser";
import { alpha, color, css, motion } from "../theme";
import { label } from "./text";

/** Ghost by default; primary gets a 14% lumen fill and lumen text (docs/08 §3). */
export class Button extends Phaser.GameObjects.Container {
  private readonly bg: Phaser.GameObjects.Graphics;
  private readonly text: Phaser.GameObjects.Text;
  private hover = false;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    text: string,
    private readonly opts: { primary?: boolean; onClick?: () => void; scale?: number } = {},
  ) {
    super(scene, x, y);
    this.text = label(scene, 0, 0, text, "body", {
      color: opts.primary ? css.lumen : css.ink,
      scale: opts.scale,
    }).setOrigin(0.5);
    this.bg = scene.add.graphics();
    this.add([this.bg, this.text]);
    const w = this.text.width + 32;
    const h = this.text.height + 16;
    this.setSize(w, h);
    this.draw();
    this.setInteractive({ useHandCursor: true })
      .on("pointerover", () => this.setHover(true))
      .on("pointerout", () => this.setHover(false))
      .on("pointerdown", () => opts.onClick?.());
    scene.add.existing(this);
  }

  private setHover(on: boolean) {
    this.hover = on;
    this.scene.tweens.add({ targets: this.text, alpha: on ? 1 : 0.92, duration: motion.hover });
    this.draw();
  }

  private draw() {
    const { width: w, height: h } = this;
    this.bg.clear();
    if (this.opts.primary || this.hover) {
      this.bg.fillStyle(color.lumen, this.opts.primary ? alpha.primaryFill : 0.06);
      this.bg.fillRoundedRect(-w / 2, -h / 2, w, h, 8);
    }
    this.bg.lineStyle(1, this.opts.primary || this.hover ? color.lumen : color.hull500, 1);
    this.bg.strokeRoundedRect(-w / 2 + 0.5, -h / 2 + 0.5, w - 1, h - 1, 8);
  }
}
