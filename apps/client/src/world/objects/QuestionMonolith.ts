import * as THREE from "three";
import { css, font } from "../../ui/theme";

// The floating question card at the centre of the arena (docs/02 §5.2). The
// full question text lives in the DOM card for reading; the monolith carries
// the number, the concept, and at the end the class average.

const W = 1024;
const H = 600;
const WIDTH = 2.6;

export class QuestionMonolith {
  readonly group = new THREE.Group();
  private readonly canvas = document.createElement("canvas");
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly frameMat: THREE.MeshBasicMaterial;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private flash = 0;
  private flashColor = new THREE.Color(css.lumen);
  private baseFrame = new THREE.Color(css.lumen).multiplyScalar(1.3);
  private time = 0;
  private turn = 0;

  constructor(private readonly still: boolean) {
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    const h = WIDTH * (H / W);
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(WIDTH, h),
      new THREE.MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        toneMapped: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.frameMat = new THREE.MeshBasicMaterial({
      color: this.baseFrame.clone(),
      toneMapped: false,
    });
    const t = 0.018;
    for (const [x, y, sx, sy] of [
      [0, h / 2, WIDTH, t],
      [0, -h / 2, WIDTH, t],
      [-WIDTH / 2, 0, t, h],
      [WIDTH / 2, 0, t, h],
    ] as const) {
      const bar = new THREE.Mesh(new THREE.PlaneGeometry(sx, sy), this.frameMat);
      bar.position.set(x, y, 0.003);
      this.group.add(bar);
      this.disposables.push(bar.geometry);
    }
    this.group.add(panel);
    this.disposables.push(panel.geometry, panel.material, this.frameMat, this.texture);
    this.draw({ label: "Module exam", title: "Preparing the questions…", foot: "" });
  }

  /** Where beams land: the bottom edge of the card, spread a little so they don't overlap. */
  target(out: THREE.Vector3, spread: number): THREE.Vector3 {
    const h = WIDTH * (H / W);
    this.group.updateWorldMatrix(true, false);
    return this.group.localToWorld(out.set(spread * WIDTH * 0.42, -h / 2, 0));
  }

  setQuestion(ord: number, total: number, concept: string, kind: string): void {
    this.turn = this.still ? 0 : Math.PI; // a half-turn reveals the next card
    this.draw({ label: `Question ${ord} of ${total}`, title: concept, foot: kind });
  }

  setResult(avg: number, passed: boolean): void {
    this.draw({
      label: passed ? "Passed" : "Not yet",
      title: `${Math.round(avg * 100)}%`,
      foot: "Class average",
      big: true,
      accent: passed ? css.aurum : css.lumen,
    });
    // A pass turns the frame gold for good.
    if (passed) this.baseFrame = new THREE.Color(css.aurum).multiplyScalar(1.4);
    this.pulse(passed ? css.aurum : css.lumen);
  }

  pulse(hex: string, strength = 1): void {
    this.flashColor.set(hex);
    this.flash = Math.max(this.flash, strength);
  }

  update(dt: number, camera: THREE.Camera): void {
    this.time += dt;
    // Face the camera (yaw only), bob gently, finish any reveal half-turn.
    const p = this.group.position;
    const yaw = Math.atan2(camera.position.x - p.x, camera.position.z - p.z);
    this.turn *= Math.exp(-dt * 4.5);
    this.group.rotation.y = yaw + this.turn;
    if (!this.still) p.y = 3.35 + Math.sin(this.time * 0.9) * 0.05;
    this.flash *= Math.exp(-dt * 4);
    this.frameMat.color
      .copy(this.baseFrame)
      .lerp(this.flashColor.clone().multiplyScalar(2.4), this.flash);
  }

  private draw(c: { label: string; title: string; foot: string; big?: boolean; accent?: string }) {
    const g = this.ctx;
    g.clearRect(0, 0, W, H);
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "rgba(11,16,32,0.92)");
    grad.addColorStop(1, "rgba(20,27,46,0.86)");
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    // Scanlines, faint.
    g.fillStyle = "rgba(91,231,255,0.035)";
    for (let y = 0; y < H; y += 6) g.fillRect(0, y, W, 2);
    g.textAlign = "center";
    g.fillStyle = c.accent ?? css.lumen;
    g.font = `600 30px ${font.display}`;
    g.letterSpacing = "6px";
    g.fillText(c.label.toUpperCase(), W / 2, 110);
    g.letterSpacing = "0px";
    g.fillStyle = css.ink;
    if (c.big) {
      g.font = `700 230px ${font.display}`;
      g.shadowColor = c.accent ?? css.lumen;
      g.shadowBlur = 40;
      g.fillText(c.title, W / 2, 380);
      g.shadowBlur = 0;
    } else {
      g.font = `700 64px ${font.display}`;
      wrap(g, c.title, W - 140)
        .slice(0, 3)
        .forEach((line, i, all) => g.fillText(line, W / 2, 300 - (all.length - 1) * 38 + i * 76));
    }
    if (c.foot) {
      g.fillStyle = css.inkDim;
      g.font = `500 30px ${font.body}`;
      g.fillText(c.foot, W / 2, H - 70);
    }
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

function wrap(g: CanvasRenderingContext2D, text: string, max: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (g.measureText(next).width > max && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}
