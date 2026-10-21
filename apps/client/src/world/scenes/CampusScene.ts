import * as THREE from "three";
import nebulaA from "../../assets/generated/nebula/a.webp";
import nebulaB from "../../assets/generated/nebula/b.webp";
import { dayPhase, PHASES } from "../lighting";
import { GasGiant } from "../objects/GasGiant";
import { SchoolWing } from "../objects/SchoolWing";
import type { WorldScene } from "../WorldScene";

// The Campus (docs/02 §1, docs/08 §4.1, M5-02): a central ring hub with radial
// arms; each School is a wing on an arm, its tier shown by its building.
// Slow idle orbit; fly-to a wing in ~1s; Lagos time-of-day lighting; streak
// "nebula fog" (docs/02 §7.4).

const SLOTS = 6;
const ARM = 34;
const loader = new THREE.TextureLoader();

export interface WingInfo {
  schoolId: string;
  slot: number;
  tier: number;
  accent: string;
  emblemUrl: string | null;
  decalUrl: string | null;
}

interface Flight {
  from: THREE.Vector3;
  to: THREE.Vector3;
  lookFrom: THREE.Vector3;
  lookTo: THREE.Vector3;
  t: number;
  duration: number;
}

export class CampusScene implements WorldScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.5, 6000);
  private readonly wings = new Map<string, { wing: SchoolWing; slot: number }>();
  private readonly giant = new GasGiant({
    radius: 90,
    sunDir: new THREE.Vector3(-0.6, 0.35, 0.7),
    ringTilt: 0.2,
  });
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly hub = new THREE.Group();
  private readonly look = new THREE.Vector3(0, 6, 0);
  private orbit = 0.6;
  private flight: Flight | null = null;
  private focusSlot: number | null = null;
  private time = 0;
  private fogTarget = 0;

  constructor() {
    const phase = PHASES[dayPhase()];
    this.scene.background = new THREE.Color(0x05070d);
    this.scene.fog = new THREE.FogExp2(0x05070d, 0);
    const key = new THREE.DirectionalLight(phase.key, phase.keyIntensity * 1.4);
    key.position.set(-80, 120, 90);
    const fill = new THREE.HemisphereLight(phase.ambient, 0x0b1020, phase.ambientIntensity * 2.2);
    this.scene.add(key, fill);

    this.buildHub();
    this.buildSky();
    this.giant.group.position.set(-260, -40, -520);
    this.giant.group.rotation.z = 0.22;
    this.scene.add(this.giant.group);
    this.placeCamera();
  }

  private buildHub() {
    const white = new THREE.MeshStandardMaterial({
      color: 0xdfe6ef,
      roughness: 0.35,
      metalness: 0.1,
    });
    const graphite = new THREE.MeshStandardMaterial({
      color: 0x1b2233,
      roughness: 0.5,
      metalness: 0.5,
    });
    const glow = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0x5be7ff).multiplyScalar(1.3),
      toneMapped: false,
    });
    const ringGeo = new THREE.TorusGeometry(14, 1.6, 16, 96);
    ringGeo.rotateX(Math.PI / 2);
    const lineGeo = new THREE.TorusGeometry(14, 0.12, 6, 128);
    lineGeo.rotateX(Math.PI / 2);
    const coreGeo = new THREE.CylinderGeometry(4, 5.5, 10, 24);
    const spireGeo = new THREE.ConeGeometry(1.2, 14, 12);
    spireGeo.translate(0, 12, 0);
    const ring = new THREE.Mesh(ringGeo, white);
    ring.position.y = 3;
    const line = new THREE.Mesh(lineGeo, glow);
    line.position.y = 4.65;
    const core = new THREE.Mesh(coreGeo, graphite);
    core.position.y = 5;
    const spire = new THREE.Mesh(spireGeo, white);
    this.hub.add(ring, line, core, spire);
    // Arms: one per slot (instanced), the empty ones dim.
    const armGeo = new THREE.BoxGeometry(1.2, 0.8, ARM - 20);
    armGeo.translate(0, 3, -(14 + (ARM - 20) / 2 + 1));
    const arms = new THREE.InstancedMesh(armGeo, graphite, SLOTS);
    const m = new THREE.Matrix4();
    for (let i = 0; i < SLOTS; i++) arms.setMatrixAt(i, m.makeRotationY(this.slotAngle(i)));
    this.hub.add(arms);
    this.scene.add(this.hub);
    this.disposables.push(white, graphite, glow, ringGeo, lineGeo, coreGeo, spireGeo, armGeo, arms);
  }

  private buildSky() {
    // A nebula skydome (two layers, inside-out spheres) so every camera angle
    // has sky behind it; additive, so the stars still shine through.
    for (const [url, radius, opacity, spin] of [
      [nebulaA, 2600, 0.85, 0],
      [nebulaB, 2400, 0.45, 1.7],
    ] as const) {
      const geo = new THREE.SphereGeometry(radius, 48, 24);
      const mat = new THREE.MeshBasicMaterial({
        side: THREE.BackSide,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
        toneMapped: false,
      });
      const dome = new THREE.Mesh(geo, mat);
      dome.rotation.y = spin;
      loader.load(url, (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.wrapS = THREE.MirroredRepeatWrapping; // no seam where the image wraps
        t.repeat.set(2, 1);
        mat.map = t;
        mat.opacity = opacity;
        mat.needsUpdate = true;
        this.disposables.push(t);
      });
      this.scene.add(dome);
      this.disposables.push(geo, mat);
    }
    const n = 2600;
    const pos = new Float32Array(n * 3);
    let seed = 23;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    for (let i = 0; i < n; i++) {
      const u = rnd() * 2 - 1;
      const t = rnd() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      pos.set([r * Math.cos(t) * 1800, u * 1800, r * Math.sin(t) * 1800], i * 3);
    }
    const geo = new THREE.BufferGeometry().setAttribute(
      "position",
      new THREE.BufferAttribute(pos, 3),
    );
    const mat = new THREE.PointsMaterial({
      color: 0xcfe0ff,
      size: 2.2,
      sizeAttenuation: true,
      fog: false,
      toneMapped: false,
    });
    this.scene.add(new THREE.Points(geo, mat));
    this.disposables.push(geo, mat);
  }

  private slotAngle(slot: number) {
    // Slot 0 faces the camera's start, the rest go round.
    return Math.PI + (slot % SLOTS) * ((Math.PI * 2) / SLOTS);
  }

  private wingPosition(slot: number) {
    const a = this.slotAngle(slot);
    return new THREE.Vector3(-Math.sin(a) * ARM, 0, -Math.cos(a) * ARM);
  }

  /** Sync wings with the campus data; returns the schools that just tiered up. */
  setWings(list: WingInfo[], seenTiers: Record<string, number>): string[] {
    const tieredUp: string[] = [];
    for (const [id, w] of this.wings)
      if (!list.some((x) => x.schoolId === id)) {
        this.scene.remove(w.wing.group);
        w.wing.dispose();
        this.wings.delete(id);
      }
    for (const info of list.slice(0, SLOTS)) {
      let w = this.wings.get(info.schoolId);
      if (!w) {
        const wing = new SchoolWing(info.accent);
        wing.group.position.copy(this.wingPosition(info.slot));
        wing.group.rotation.y = this.slotAngle(info.slot);
        this.scene.add(wing.group);
        w = { wing, slot: info.slot };
        this.wings.set(info.schoolId, w);
      }
      const seen = seenTiers[info.schoolId];
      const up = seen !== undefined && info.tier > seen;
      if (up) tieredUp.push(info.schoolId);
      w.wing.setTier(info.tier, up);
      w.wing.setEmblem(info.emblemUrl);
      w.wing.setDecal(info.decalUrl);
    }
    return tieredUp;
  }

  /** Fly to a School's wing (~1s spline), or back to the overview (null). */
  flyTo(schoolId: string | null): void {
    const w = schoolId ? this.wings.get(schoolId) : undefined;
    const slot = w?.slot ?? null;
    if (slot === this.focusSlot) return;
    this.focusSlot = slot;
    const toLook =
      slot === null
        ? new THREE.Vector3(0, 6, 0)
        : this.wingPosition(slot).add(new THREE.Vector3(0, 14, 0));
    // Frame the whole building: out past the wing along its arm, a little to the side, above.
    const toPos =
      slot === null
        ? this.orbitPosition()
        : (() => {
            const w = this.wingPosition(slot);
            const out = w.clone().setY(0).normalize();
            const side = new THREE.Vector3(-out.z, 0, out.x);
            return w
              .add(out.multiplyScalar(52))
              .add(side.multiplyScalar(14))
              .add(new THREE.Vector3(0, 30, 0));
          })();
    this.flight = {
      from: this.camera.position.clone(),
      to: toPos,
      lookFrom: this.look.clone(),
      lookTo: toLook,
      t: 0,
      duration: 1.05,
    };
  }

  /** Streak fog: 0 when taught today/yesterday, light after a missed day, thick after three. */
  setFog(missedDays: number): void {
    this.fogTarget = missedDays <= 1 ? 0 : missedDays < 3 ? 0.0024 : 0.0055;
  }

  private orbitPosition() {
    return new THREE.Vector3(Math.sin(this.orbit) * 105, 46, Math.cos(this.orbit) * 105);
  }

  private placeCamera() {
    this.camera.position.copy(this.orbitPosition());
    this.camera.lookAt(this.look);
  }

  update(dt: number): void {
    this.time += dt;
    const fog = this.scene.fog as THREE.FogExp2;
    fog.density += (this.fogTarget - fog.density) * Math.min(1, dt * 1.5);
    if (this.flight) {
      const f = this.flight;
      f.t = Math.min(1, f.t + dt / f.duration);
      const e = f.t < 0.5 ? 4 * f.t ** 3 : 1 - (-2 * f.t + 2) ** 3 / 2; // ease in-out
      // A gentle arc: lift through the middle of the flight.
      const arc = Math.sin(e * Math.PI) * 8;
      this.camera.position.lerpVectors(f.from, f.to, e).add(new THREE.Vector3(0, arc, 0));
      this.look.lerpVectors(f.lookFrom, f.lookTo, e);
      if (f.t >= 1) this.flight = null;
    } else if (this.focusSlot === null) {
      // Idle: a slow orbit (docs/08 §4.5: 0.02 rad/s, never a roll).
      this.orbit += dt * 0.02;
      this.camera.position.lerp(this.orbitPosition(), Math.min(1, dt * 2));
    }
    this.camera.lookAt(this.look);
    for (const { wing } of this.wings.values()) wing.update(dt);
    this.giant.lookFrom(this.camera);
    this.giant.update(dt);
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    // The setup screens' column covers the left; centre the station in what's
    // left on wide screens by shifting the projection (no camera move, no roll).
    if (width > 1000) this.camera.setViewOffset(width, height, -width * 0.22, 0, width, height);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    for (const { wing } of this.wings.values()) wing.dispose();
    this.giant.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
