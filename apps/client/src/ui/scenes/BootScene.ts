import * as Phaser from "phaser";
import { bus } from "../../core/bus";

/** M0: a single clickable button over the 3D world. */
export class BootScene extends Phaser.Scene {
  private button?: Phaser.GameObjects.Container;

  constructor() {
    super("boot");
  }

  create(): void {
    const bg = this.add.rectangle(0, 0, 220, 56, 0x0b1020, 0.85).setStrokeStyle(2, 0x5be7ff);
    const label = this.add
      .text(0, 0, "Ping the world", {
        fontFamily: "system-ui, sans-serif",
        fontSize: "20px",
        color: "#E6EDF7",
      })
      .setOrigin(0.5);
    this.button = this.add.container(0, 0, [bg, label]).setSize(220, 56);
    this.button
      .setInteractive({ useHandCursor: true })
      .on("pointerover", () => bg.setFillStyle(0x141b2e, 0.95))
      .on("pointerout", () => bg.setFillStyle(0x0b1020, 0.85))
      .on("pointerdown", () => bus.emit("ui:ping"));

    this.layout();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.layout, this);
  }

  private layout(): void {
    const { width, height } = this.scale.gameSize;
    this.button?.setPosition(width / 2, height - 80);
  }
}
