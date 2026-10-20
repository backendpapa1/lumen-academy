import * as Phaser from "phaser";
import { alpha, color, shape } from "../theme";

/**
 * The HUD's signature surface (docs/08 §3): glass over a dark base, 1px hull
 * border, 12px corners with the top-right corner chamfered. `focused` swaps
 * the border for lumen plus a soft outer glow.
 */
export class Panel extends Phaser.GameObjects.Container {
  private readonly g: Phaser.GameObjects.Graphics;
  private pw: number;
  private ph: number;
  private focused = false;

  constructor(scene: Phaser.Scene, x: number, y: number, width: number, height: number) {
    super(scene, x, y);
    this.pw = width;
    this.ph = height;
    this.g = scene.add.graphics();
    this.add(this.g);
    this.setSize(width, height);
    this.redraw();
    scene.add.existing(this);
  }

  resize(width: number, height: number): this {
    this.pw = width;
    this.ph = height;
    this.setSize(width, height);
    this.redraw();
    return this;
  }

  setFocused(on: boolean): this {
    this.focused = on;
    this.redraw();
    return this;
  }

  get panelWidth() {
    return this.pw;
  }
  get panelHeight() {
    return this.ph;
  }

  private path(g: Phaser.GameObjects.Graphics, inset = 0) {
    const r = shape.radius - inset;
    const c = shape.chamfer;
    const x = inset;
    const y = inset;
    const w = this.pw - inset * 2;
    const h = this.ph - inset * 2;
    g.beginPath();
    g.moveTo(x + r, y);
    g.lineTo(x + w - c, y);
    g.lineTo(x + w, y + c);
    g.lineTo(x + w, y + h - r);
    g.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    g.lineTo(x + r, y + h);
    g.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    g.lineTo(x, y + r);
    g.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
    g.closePath();
  }

  private redraw() {
    const g = this.g;
    g.clear();
    if (this.focused) {
      // Outer glow: a few widening, fading strokes (one strong glow per view).
      for (let i = 3; i >= 1; i--) {
        g.lineStyle(i * 3, color.lumen, alpha.focusGlow / (i + 1));
        this.path(g, -i);
        g.strokePath();
      }
    }
    g.fillStyle(color.hull900, alpha.panelBase);
    this.path(g);
    g.fillPath();
    g.fillStyle(color.glass, alpha.glass);
    this.path(g);
    g.fillPath();
    g.lineStyle(1, this.focused ? color.lumen : color.hull500, 1);
    this.path(g, 0.5);
    g.strokePath();
  }
}
