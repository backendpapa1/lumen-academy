import * as THREE from "three";

// 3 curved tiers × 5 seats facing the lectern at the origin (docs/08 §4.2).
// Seats and their accent rims are instanced: 2 draw calls for all 15.

export const SEATS = 15;
const TIERS = [
  { radius: 5.2, height: 0.35 },
  { radius: 7.0, height: 1.05 },
  { radius: 8.8, height: 1.75 },
];
const ARC = THREE.MathUtils.degToRad(84); // total angle each tier spans
const EMPTY_RIM = 0x22304d;

export interface SeatPose {
  position: THREE.Vector3; // floor of the seat (where a hologram stands)
  facing: number; // y rotation so the seat faces the lectern
}

export function seatPose(seat: number): SeatPose {
  const tier = TIERS[Math.floor(seat / 5)]!;
  const k = seat % 5;
  const angle = -ARC / 2 + (ARC * k) / 4;
  const position = new THREE.Vector3(
    Math.sin(angle) * tier.radius,
    tier.height,
    -Math.cos(angle) * tier.radius,
  );
  return { position, facing: -angle };
}

export class Amphitheater {
  readonly group = new THREE.Group();
  private readonly consoles: THREE.InstancedMesh;
  private readonly rims: THREE.InstancedMesh;
  private readonly disposables: Array<{ dispose(): void }> = [];

  constructor() {
    // Tier platforms: curved slabs (ring segments extruded down to the floor).
    const tierMat = new THREE.MeshStandardMaterial({
      color: 0x131a2c,
      roughness: 0.45,
      metalness: 0.25,
    });
    // polygonOffset keeps the lip from z-fighting with the step it sits on.
    const edgeMat = new THREE.MeshBasicMaterial({
      color: 0x1ba8d6,
      toneMapped: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.disposables.push(tierMat, edgeMat);
    TIERS.forEach((t, i) => {
      const inner = t.radius - 0.95;
      const outer = t.radius + 0.95;
      const shape = new THREE.Shape();
      const a0 = -Math.PI / 2 - ARC / 2 - 0.18;
      const a1 = -Math.PI / 2 + ARC / 2 + 0.18;
      shape.absarc(0, 0, outer, a0, a1, false);
      shape.absarc(0, 0, inner, a1, a0, true);
      const geo = new THREE.ExtrudeGeometry(shape, {
        depth: t.height + 0.01,
        bevelEnabled: false,
        curveSegments: 48,
      });
      geo.rotateX(Math.PI / 2);
      geo.translate(0, t.height, 0);
      const slab = new THREE.Mesh(geo, tierMat);
      slab.receiveShadow = false;
      this.group.add(slab);
      // Thin lumen edge along each step's front lip: a flat arc on the top face.
      const lipShape = new THREE.Shape();
      lipShape.absarc(0, 0, inner + 0.07, a0, a1, false);
      lipShape.absarc(0, 0, inner + 0.02, a1, a0, true);
      const lipGeo = new THREE.ShapeGeometry(lipShape, 48);
      lipGeo.rotateX(Math.PI / 2);
      lipGeo.translate(0, t.height + 0.012, 0);
      this.group.add(new THREE.Mesh(lipGeo, edgeMat));
      this.disposables.push(geo, lipGeo);
      void i;
    });

    // Graphite consoles + accent rims, instanced.
    const consoleGeo = new THREE.BoxGeometry(0.9, 0.55, 0.45);
    consoleGeo.translate(0, 0.275, 0.35);
    const consoleMat = new THREE.MeshStandardMaterial({
      color: 0x2a3247,
      roughness: 0.32,
      metalness: 0.35,
    });
    const rimGeo = new THREE.BoxGeometry(0.92, 0.025, 0.04);
    rimGeo.translate(0, 0.56, 0.58);
    const rimMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    this.consoles = new THREE.InstancedMesh(consoleGeo, consoleMat, SEATS);
    this.rims = new THREE.InstancedMesh(rimGeo, rimMat, SEATS);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (let s = 0; s < SEATS; s++) {
      const pose = seatPose(s);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), pose.facing);
      m.compose(pose.position, q, new THREE.Vector3(1, 1, 1));
      this.consoles.setMatrixAt(s, m);
      this.rims.setMatrixAt(s, m);
      this.rims.setColorAt(s, new THREE.Color(EMPTY_RIM));
    }
    this.group.add(this.consoles, this.rims);
    this.disposables.push(consoleGeo, consoleMat, rimGeo, rimMat);
  }

  /** Accent rim when occupied (dimmed to keep bloom for speakers), hull when empty. */
  setOccupancy(accentBySeat: Map<number, number>): void {
    for (let s = 0; s < SEATS; s++) {
      const accent = accentBySeat.get(s);
      const c = new THREE.Color(accent ?? EMPTY_RIM);
      if (accent !== undefined) c.multiplyScalar(0.55);
      this.rims.setColorAt(s, c);
    }
    this.rims.instanceColor!.needsUpdate = true;
  }

  /** Brighten one rim past the bloom threshold (speaking / hand raised). */
  highlight(seat: number | null, accent: number): void {
    if (seat === null) return;
    this.rims.setColorAt(seat, new THREE.Color(accent).multiplyScalar(1.6));
    this.rims.instanceColor!.needsUpdate = true;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.consoles.dispose();
    this.rims.dispose();
  }
}
