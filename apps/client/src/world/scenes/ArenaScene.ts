import * as THREE from "three";
import type { Archetype } from "@lumen/shared";
import nebulaA from "../../assets/generated/nebula/a.webp";
import { SERVER_HTTP } from "../../core/net";
import { accentOf, color, css, reducedMotion } from "../../ui/theme";
import { world } from "../anchors";
import { AnswerBeam, type Verdict } from "../objects/AnswerBeam";
import { CadetHologram } from "../objects/CadetHologram";
import { HexFloor } from "../objects/HexFloor";
import { IntegrityRing } from "../objects/IntegrityRing";
import { QuestionMonolith } from "../objects/QuestionMonolith";
import { TerminalRing, terminalPose } from "../objects/TerminalRing";
import type { WorldScene } from "../WorldScene";

// The Exam Arena (docs/02 §5.2, M6-09): cadets at holo-terminals in a ring,
// the question floating over the dais, every graded answer a beam of light
// that locks green or shatters red, and Class Integrity filling the floor.

const CAMERA_POS = new THREE.Vector3(0, 5.0, 10.8);
const LOOK_AT = new THREE.Vector3(0, 1.9, 0);
const FINAL_POS = new THREE.Vector3(0, 3.7, 6.4);
const FINAL_LOOK = new THREE.Vector3(0, 3.1, 0);

export interface ArenaCadet {
  id: string;
  archetype: Archetype;
  portraitUrl?: string | null;
}

export class ArenaScene implements WorldScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(46, 1, 0.1, 900);
  private readonly still = reducedMotion();
  private readonly floor = new HexFloor();
  private readonly terminals = new TerminalRing();
  private readonly monolith = new QuestionMonolith(this.still);
  private readonly ring = new IntegrityRing(1.75, 2.1, 0.7);
  private readonly holograms = new Map<string, { h: CadetHologram; i: number }>();
  private readonly beams: Array<{ beam: AnswerBeam; base: THREE.Vector3 }> = [];
  private readonly disposables: Array<{ dispose(): void }> = [];
  private time = 0;
  /** 0 → 1 as the camera pushes in for the final reveal. */
  private finale = -1;
  private readonly look = LOOK_AT.clone();

  constructor() {
    this.scene.background = new THREE.Color(color.void);
    this.scene.fog = new THREE.FogExp2(color.void, 0.022);
    this.scene.add(
      new THREE.HemisphereLight(0x9fb6d8, color.hull900, 0.9),
      (() => {
        const key = new THREE.DirectionalLight(0xeaf2ff, 1.6);
        key.position.set(-6, 12, 8);
        return key;
      })(),
      (() => {
        // The card lights the dais from above.
        const glow = new THREE.PointLight(color.lumen, 6, 9, 1.6);
        glow.position.set(0, 2.6, 0);
        return glow;
      })(),
    );

    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(600, 48, 24),
      new THREE.MeshBasicMaterial({
        map: new THREE.TextureLoader().load(nebulaA, (t) => (t.colorSpace = THREE.SRGBColorSpace)),
        side: THREE.BackSide,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        fog: false,
        toneMapped: false,
      }),
    );
    dome.rotation.y = 2.2;
    this.disposables.push(dome.geometry, dome.material as THREE.Material);

    // The dais: a low dark drum with a lumen rim, the integrity arc around it.
    const daisGeo = new THREE.CylinderGeometry(1.45, 1.6, 0.28, 48);
    daisGeo.translate(0, 0.14, 0);
    const dais = new THREE.Mesh(
      daisGeo,
      new THREE.MeshStandardMaterial({ color: color.hull700, metalness: 0.7, roughness: 0.3 }),
    );
    const rimGeo = new THREE.TorusGeometry(1.46, 0.016, 8, 96);
    rimGeo.rotateX(Math.PI / 2);
    rimGeo.translate(0, 0.285, 0);
    const rim = new THREE.Mesh(
      rimGeo,
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(color.lumen).multiplyScalar(1.6),
        toneMapped: false,
      }),
    );
    // An outer boundary line where the terminals stand.
    const boundGeo = new THREE.RingGeometry(6.35, 6.4, 128);
    boundGeo.rotateX(-Math.PI / 2);
    const bound = new THREE.Mesh(
      boundGeo,
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(color.lumen).multiplyScalar(0.5),
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    bound.position.y = 0.01;
    this.ring.mesh.position.y = 0.015;
    this.disposables.push(
      daisGeo,
      dais.material as THREE.Material,
      rimGeo,
      rim.material as THREE.Material,
      boundGeo,
      bound.material as THREE.Material,
    );
    this.monolith.group.position.set(0, 3.35, 0);

    this.scene.add(
      dome,
      this.floor.mesh,
      dais,
      rim,
      bound,
      this.ring.mesh,
      this.terminals.group,
      this.monolith.group,
    );
    this.camera.position.copy(CAMERA_POS);
    this.camera.lookAt(LOOK_AT);
    world.pick = null;
  }

  setCadets(list: ArenaCadet[]): void {
    for (const { h } of this.holograms.values()) {
      this.scene.remove(h.group);
      h.dispose();
    }
    this.holograms.clear();
    this.terminals.set(list.map((c) => accentOf(c.archetype)));
    list.forEach((c, i) => {
      const pose = terminalPose(i, list.length);
      const h = new CadetHologram(c.id, i, accentOf(c.archetype), hash(c.id));
      h.group.position.copy(pose.stand);
      h.group.rotation.y = pose.facing;
      h.setPortrait(c.portraitUrl ? SERVER_HTTP + c.portraitUrl : null);
      this.holograms.set(c.id, { h, i });
      this.scene.add(h.group);
    });
  }

  setPassMark(pass: number): void {
    this.ring.set(0, pass);
  }

  setIntegrity(v: number): void {
    this.ring.set(v);
  }

  setQuestion(ord: number, total: number, concept: string, kind: string): void {
    this.monolith.setQuestion(ord, total, concept, kind);
  }

  /** One graded answer: a beam from that cadet's terminal to the card. */
  answer(cadetId: string, score: number): void {
    const c = this.holograms.get(cadetId);
    if (!c) return;
    const verdict: Verdict = score >= 0.6 ? "lock" : score >= 0.3 ? "partial" : "shatter";
    const n = this.holograms.size;
    const pose = terminalPose(c.i, n);
    const spread = n > 1 ? (c.i / (n - 1)) * 2 - 1 : 0;
    const beam = new AnswerBeam(
      pose.emitter,
      this.monolith.target(new THREE.Vector3(), -spread),
      verdict,
      this.still,
    );
    this.beams.push({ beam, base: pose.base });
    this.scene.add(beam.group);
    this.terminals.flare(c.i, color.lumen);
    c.h.setState(
      verdict === "lock" ? "excited" : verdict === "partial" ? "notetaking" : "confused",
      this.time,
    );
  }

  finish(avg: number, passed: boolean): void {
    this.monolith.setResult(avg, passed);
    this.ring.set(avg);
    this.finale = this.still ? 1 : 0;
    for (const { h } of this.holograms.values())
      h.setState(passed ? "excited" : "attentive", this.time);
  }

  update(dt: number): void {
    this.time += dt;
    // A slow orbit keeps the room alive; the finale pushes in on the card.
    const orbit = this.still ? 0 : Math.sin(this.time * 0.08) * 0.14;
    const base = new THREE.Vector3(
      Math.sin(orbit) * CAMERA_POS.z,
      CAMERA_POS.y,
      Math.cos(orbit) * CAMERA_POS.z,
    );
    if (this.finale >= 0 && this.finale < 1) this.finale = Math.min(1, this.finale + dt / 3.2);
    const f = this.finale < 0 ? 0 : smooth(this.finale);
    this.camera.position.lerpVectors(base, FINAL_POS, f);
    this.look.lerpVectors(LOOK_AT, FINAL_LOOK, f);
    this.camera.lookAt(this.look);

    this.floor.update(dt);
    this.terminals.update(dt);
    this.ring.update(dt);
    this.monolith.update(dt, this.camera);
    for (const { h } of this.holograms.values()) h.update(dt, this.camera);
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const { beam, base } = this.beams[i]!;
      beam.update(dt);
      if (beam.arrived) {
        if (beam.verdict === "lock") {
          this.monolith.pulse(css.success, 0.8);
          this.floor.ripple(base);
        } else if (beam.verdict === "shatter") this.monolith.pulse(css.danger, 0.6);
      }
      if (beam.done) {
        this.scene.remove(beam.group);
        beam.dispose();
        this.beams.splice(i, 1);
      }
    }
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    // Narrow screens: pull back so the whole ring stays in frame.
    this.camera.fov = width / height < 1.2 ? 62 : 46;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    for (const { h } of this.holograms.values()) h.dispose();
    for (const { beam } of this.beams) beam.dispose();
    this.floor.dispose();
    this.terminals.dispose();
    this.monolith.dispose();
    this.ring.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

const smooth = (t: number) => t * t * (3 - 2 * t);

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
  return h >>> 0;
}
