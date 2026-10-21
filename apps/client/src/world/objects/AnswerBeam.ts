import * as THREE from "three";
import { color } from "../../ui/theme";
import frag from "../shaders/answerBeam.frag.glsl?raw";
import vert from "../shaders/hologram.vert.glsl?raw";

// One graded answer, drawn as light (docs/02 §5.2, docs/08 §4.6): the beam
// reaches from a terminal to the question card, then locks (good: green, a
// snap and a flash; partial: amber) or shatters into 40 red shards (wrong).

const REACH = 0.45; // seconds to reach the card
const HOLD = 1.6; // a locked beam lingers, then fades
const FADE = 0.7;
const SHARDS = 40;

const beamGeo = new THREE.CylinderGeometry(0.018, 0.05, 1, 10, 1, true);
beamGeo.translate(0, 0.5, 0); // origin at the terminal end
const UP = new THREE.Vector3(0, 1, 0);

export type Verdict = "lock" | "partial" | "shatter";

export class AnswerBeam {
  readonly group = new THREE.Group();
  private readonly beam: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>;
  private readonly shards: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private readonly velocities = new Float32Array(SHARDS * 3);
  private readonly length: number;
  private readonly dir: THREE.Vector3;
  private age = 0;
  private shattered = false;
  done = false;

  constructor(
    private readonly from: THREE.Vector3,
    to: THREE.Vector3,
    readonly verdict: Verdict,
    private readonly still: boolean,
  ) {
    const tint =
      verdict === "lock" ? color.success : verdict === "partial" ? color.aurum : color.danger;
    this.dir = new THREE.Vector3().subVectors(to, from);
    this.length = this.dir.length();
    this.dir.normalize();
    this.beam = new THREE.Mesh(
      beamGeo,
      new THREE.ShaderMaterial({
        vertexShader: vert,
        fragmentShader: frag,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: {
          // Every beam leaves the terminal in lumen and takes its verdict colour on arrival.
          uColor: { value: new THREE.Color(color.lumen) },
          uTint: { value: new THREE.Color(tint) },
          uTime: { value: Math.random() * 5 },
          uStrength: { value: 1 },
          uFlash: { value: 0 },
        },
      }),
    );
    this.beam.position.copy(from);
    this.beam.quaternion.setFromUnitVectors(UP, this.dir);
    this.beam.scale.set(1, still ? this.length : 0.001, 1);
    this.group.add(this.beam);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(SHARDS * 3), 3));
    this.shards = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color: new THREE.Color(color.danger).multiplyScalar(1.8),
        size: 0.07,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    );
    this.shards.visible = false;
    this.group.add(this.shards);
  }

  /** True once, on the frame the beam arrives (the scene flashes the card / ripples the floor). */
  arrived = false;

  update(dt: number): void {
    this.age += dt;
    this.arrived = false;
    const u = this.beam.material.uniforms;
    u.uTime!.value += dt;
    const reach = this.still ? 1 : Math.min(1, this.age / REACH);
    this.beam.scale.y = Math.max(0.001, this.length * easeOut(reach));
    if (reach >= 1 && !u.uColor!.value.equals(u.uTint!.value) && !this.shattered) {
      u.uColor!.value.copy(u.uTint!.value);
      this.arrived = true;
      if (this.verdict === "shatter") this.shatter();
      else u.uFlash!.value = this.verdict === "lock" ? 1 : 0.5;
    }
    u.uFlash!.value *= Math.exp(-dt * 5);
    const since = this.age - REACH;
    if (this.shattered) {
      // The beam breaks: shards fall away from the line, the beam itself is gone in 0.15s.
      u.uStrength!.value = Math.max(0, 1 - since / 0.15);
      const pos = this.shards.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < SHARDS; i++) {
        this.velocities[i * 3 + 1]! -= 4.5 * dt;
        pos.setXYZ(
          i,
          pos.getX(i) + this.velocities[i * 3]! * dt,
          pos.getY(i) + this.velocities[i * 3 + 1]! * dt,
          pos.getZ(i) + this.velocities[i * 3 + 2]! * dt,
        );
      }
      pos.needsUpdate = true;
      this.shards.material.opacity = Math.max(0, 1 - since / 1.1);
      if (since > 1.2) this.done = true;
    } else if (since > HOLD) {
      u.uStrength!.value = Math.max(0, 1 - (since - HOLD) / FADE);
      if (since > HOLD + FADE) this.done = true;
    }
  }

  private shatter(): void {
    this.shattered = true;
    this.shards.visible = true;
    const pos = this.shards.geometry.attributes.position as THREE.BufferAttribute;
    const p = new THREE.Vector3();
    for (let i = 0; i < SHARDS; i++) {
      p.copy(this.from).addScaledVector(this.dir, this.length * (0.15 + Math.random() * 0.85));
      pos.setXYZ(i, p.x, p.y, p.z);
      this.velocities[i * 3] = (Math.random() - 0.5) * 2.4;
      this.velocities[i * 3 + 1] = Math.random() * 1.6;
      this.velocities[i * 3 + 2] = (Math.random() - 0.5) * 2.4;
    }
    pos.needsUpdate = true;
    this.shards.material.opacity = 1;
  }

  dispose(): void {
    this.beam.material.dispose();
    this.shards.geometry.dispose();
    this.shards.material.dispose();
  }
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;
