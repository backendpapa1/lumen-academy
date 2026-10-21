import * as THREE from "three";
import { color } from "../../ui/theme";

// Holo-terminals on an arc around the dais (docs/02 §5.2), open towards the
// Headmaster's platform. One instanced pedestal + one instanced glowing cap.

export const TERMINAL_RADIUS = 5.2;
/** The arc leaves a 60° opening facing the camera (+z). */
const OPEN = Math.PI / 3;

export interface TerminalPose {
  /** Pedestal base on the floor. */
  base: THREE.Vector3;
  /** Where the answer beam leaves the terminal. */
  emitter: THREE.Vector3;
  /** Where the cadet stands (behind the pedestal, facing the centre). */
  stand: THREE.Vector3;
  facing: number;
}

export function terminalPose(i: number, n: number): TerminalPose {
  const a = n === 1 ? Math.PI : OPEN / 2 + ((2 * Math.PI - OPEN) * (i + 0.5)) / n;
  const at = (r: number, y: number) => new THREE.Vector3(Math.sin(a) * r, y, Math.cos(a) * r);
  return {
    base: at(TERMINAL_RADIUS, 0),
    emitter: at(TERMINAL_RADIUS - 0.22, 1.02),
    stand: at(TERMINAL_RADIUS + 0.55, 0),
    facing: a + Math.PI,
  };
}

const pedestalGeo = new THREE.CylinderGeometry(0.26, 0.38, 0.92, 6);
pedestalGeo.translate(0, 0.46, 0);
const capGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.035, 6);
capGeo.translate(0, 0.94, 0);

export class TerminalRing {
  readonly group = new THREE.Group();
  private pedestals: THREE.InstancedMesh | null = null;
  private caps: THREE.InstancedMesh | null = null;
  private readonly pedestalMat = new THREE.MeshStandardMaterial({
    color: color.hull700,
    metalness: 0.6,
    roughness: 0.35,
  });
  private readonly capMat = new THREE.MeshBasicMaterial({ toneMapped: false });
  private glow: number[] = [];
  private accents: THREE.Color[] = [];

  /** One terminal per cadet, lit in that cadet's accent. */
  set(accents: number[]): void {
    this.clear();
    const n = accents.length;
    if (!n) return;
    this.pedestals = new THREE.InstancedMesh(pedestalGeo, this.pedestalMat, n);
    this.caps = new THREE.InstancedMesh(capGeo, this.capMat, n);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    this.accents = accents.map((a) => new THREE.Color(a));
    this.glow = accents.map(() => 0);
    for (let i = 0; i < n; i++) {
      const p = terminalPose(i, n);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.facing);
      m.compose(p.base, q, new THREE.Vector3(1, 1, 1));
      this.pedestals.setMatrixAt(i, m);
      this.caps.setMatrixAt(i, m);
      this.caps.setColorAt(i, this.accents[i]!.clone().multiplyScalar(0.9));
    }
    this.group.add(this.pedestals, this.caps);
  }

  /** A terminal flares when its answer is sent. */
  flare(i: number, hex: number): void {
    if (i < 0 || i >= this.glow.length) return;
    this.glow[i] = 1;
    this.accents[i] = new THREE.Color(hex);
  }

  update(dt: number): void {
    if (!this.caps) return;
    const c = new THREE.Color();
    let dirty = false;
    for (let i = 0; i < this.glow.length; i++) {
      if (this.glow[i]! <= 0.001) continue;
      this.glow[i]! *= Math.exp(-dt * 1.6);
      c.copy(this.accents[i]!).multiplyScalar(0.9 + this.glow[i]! * 2.2);
      this.caps.setColorAt(i, c);
      dirty = true;
    }
    if (dirty && this.caps.instanceColor) this.caps.instanceColor.needsUpdate = true;
  }

  private clear(): void {
    for (const m of [this.pedestals, this.caps]) {
      if (!m) continue;
      this.group.remove(m);
      m.dispose();
    }
    this.pedestals = this.caps = null;
  }

  dispose(): void {
    this.clear();
    this.pedestalMat.dispose();
    this.capMat.dispose();
  }
}
