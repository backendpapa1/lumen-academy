import * as THREE from "three";

// Holographic board (docs/02 §3.1): current concept, the last key point, and
// the class understanding meter. Drawn to a canvas texture for crisp text.

const W = 1280;
const H = 720;

export interface BoardContent {
  concept: string;
  point: string;
  understanding: number | null; // 0..1
  board?: string; // chalkboard block (T-9, M6)
}

export class HoloBoard {
  readonly group = new THREE.Group();
  private readonly canvas = document.createElement("canvas");
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private last = "";

  constructor() {
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(4.2, 4.2 * (H / W)),
      new THREE.MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        toneMapped: false,
        depthWrite: false,
      }),
    );
    this.group.add(panel);
    // Lumen frame: four thin bars, bright enough to bloom softly.
    const frameMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0x5be7ff).multiplyScalar(1.3),
      toneMapped: false,
    });
    const w = 4.2;
    const h = 4.2 * (H / W);
    for (const [x, y, sx, sy] of [
      [0, h / 2, w, 0.015],
      [0, -h / 2, w, 0.015],
      [-w / 2, 0, 0.015, h],
      [w / 2, 0, 0.015, h],
    ] as const) {
      const bar = new THREE.Mesh(new THREE.PlaneGeometry(sx, sy), frameMat);
      bar.position.set(x, y, 0.002);
      this.group.add(bar);
      this.disposables.push(bar.geometry);
    }
    this.disposables.push(panel.geometry, panel.material, frameMat, this.texture);
    this.set({ concept: "", point: "", understanding: null });
  }

  set(c: BoardContent): void {
    const key = JSON.stringify(c);
    if (key === this.last) return;
    this.last = key;
    const g = this.ctx;
    g.clearRect(0, 0, W, H);
    g.fillStyle = "rgba(11,16,32,0.55)";
    g.fillRect(0, 0, W, H);
    g.fillStyle = "rgba(140,180,255,0.06)";
    g.fillRect(0, 0, W, H);
    const pad = 64;
    g.fillStyle = "#8A96AD";
    g.font = '500 26px "Space Grotesk"';
    g.letterSpacing = "2px";
    g.fillText("NOW TEACHING", pad, pad + 20);
    g.letterSpacing = "0px";
    g.fillStyle = "#E6EDF7";
    g.font = '700 64px "Space Grotesk"';
    wrap(g, c.concept || "Waiting for class…", pad, pad + 100, W - pad * 2, 72, 2);
    g.fillStyle = "#C9D4E5";
    g.font = '400 34px "Inter"';
    if (c.point) wrap(g, `“${c.point}”`, pad, pad + 290, W - pad * 2, 48, 4);
    if (c.understanding !== null) {
      const y = H - pad - 10;
      g.fillStyle = "#8A96AD";
      g.font = '500 24px "Space Grotesk"';
      g.letterSpacing = "2px";
      g.fillText("CLASS UNDERSTANDING", pad, y - 28);
      g.letterSpacing = "0px";
      g.fillStyle = "#22304D";
      g.fillRect(pad, y, W - pad * 2 - 140, 8);
      g.fillStyle = "#5BE7FF";
      g.fillRect(pad, y, (W - pad * 2 - 140) * c.understanding, 8);
      g.fillStyle = "#E6EDF7";
      g.font = '600 36px "JetBrains Mono"';
      g.fillText(`${Math.round(c.understanding * 100)}%`, W - pad - 110, y + 12);
    }
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

function wrap(
  g: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxW: number,
  lineH: number,
  maxLines: number,
) {
  const words = text.split(/\s+/);
  let line = "";
  let lines = 0;
  for (let i = 0; i < words.length; i++) {
    const test = line ? `${line} ${words[i]}` : words[i]!;
    if (g.measureText(test).width > maxW && line) {
      if (lines === maxLines - 1) {
        g.fillText(`${line}…`, x, y + lines * lineH);
        return;
      }
      g.fillText(line, x, y + lines * lineH);
      line = words[i]!;
      lines++;
    } else line = test;
  }
  if (line) g.fillText(line, x, y + lines * lineH);
}
