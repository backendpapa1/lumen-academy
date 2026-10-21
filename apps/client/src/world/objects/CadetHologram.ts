import { REACTION_GLYPHS, type ReactionState } from "@lumen/shared";
import * as THREE from "three";
import { reducedMotion } from "../../ui/theme";
import beamFrag from "../shaders/beam.frag.glsl?raw";
import frag from "../shaders/hologram.frag.glsl?raw";
import vert from "../shaders/hologram.vert.glsl?raw";
import { seatPose } from "./Amphitheater";

// A cadet as a holographic billboard on its seat (docs/02 §3.2, docs/08 §4.3).
// Every state maps to a set of targets that the hologram eases toward.

interface Targets {
  brightness: number;
  flicker: number;
  tilt: number; // sideways (confused)
  lean: number; // forward (attentive)
  bounce: number; // excited
  drift: number; // bored
  skeptic: number;
  pad: number; // notetaking glow
}

const STATE: Record<ReactionState, Targets> = {
  attentive: {
    brightness: 1.0,
    flicker: 0.02,
    tilt: 0,
    lean: 0.07,
    bounce: 0,
    drift: 0,
    skeptic: 0,
    pad: 0,
  },
  confused: {
    brightness: 0.95,
    flicker: 0.12,
    tilt: 0.13,
    lean: 0,
    bounce: 0,
    drift: 0,
    skeptic: 0,
    pad: 0,
  },
  excited: {
    brightness: 1.15,
    flicker: 0.02,
    tilt: 0,
    lean: 0.05,
    bounce: 1,
    drift: 0,
    skeptic: 0,
    pad: 0,
  },
  bored: {
    brightness: 0.6,
    flicker: 0.03,
    tilt: -0.05,
    lean: -0.06,
    bounce: 0,
    drift: 1,
    skeptic: 0,
    pad: 0,
  },
  skeptical: {
    brightness: 0.95,
    flicker: 0.02,
    tilt: 0,
    lean: -0.04,
    bounce: 0,
    drift: 0,
    skeptic: 1,
    pad: 0,
  },
  notetaking: {
    brightness: 0.95,
    flicker: 0.02,
    tilt: 0,
    lean: 0.1,
    bounce: 0,
    drift: 0,
    skeptic: 0,
    pad: 1,
  },
};

const glyphTextures = new Map<string, THREE.CanvasTexture>();
function glyphTexture(glyph: string): THREE.CanvasTexture {
  let t = glyphTextures.get(glyph);
  if (!t) {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d")!;
    g.font = '700 92px "Space Grotesk"';
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "#ffffff";
    g.fillText(glyph, 64, 70);
    t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    glyphTextures.set(glyph, t);
  }
  return t;
}

const BILLBOARD_W = 1.0;
const BILLBOARD_H = 1.4;
const quad = new THREE.PlaneGeometry(BILLBOARD_W, BILLBOARD_H);
quad.translate(0, BILLBOARD_H / 2, 0);
const beamGeo = new THREE.CylinderGeometry(0.055, 0.055, 3.1, 12, 1, true); // stops below the board
beamGeo.translate(0, 1.55, 0);
const discGeo = new THREE.PlaneGeometry(2.2, 2.2);
discGeo.rotateX(-Math.PI / 2);

/** Soft radial falloff for the speaking spotlight (a glow, not a disc). */
let spotTexture: THREE.CanvasTexture | null = null;
function radialTexture(): THREE.CanvasTexture {
  if (spotTexture) return spotTexture;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.45)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  spotTexture = new THREE.CanvasTexture(c);
  return spotTexture;
}
const padGeo = new THREE.PlaneGeometry(0.26, 0.17);

export class CadetHologram {
  readonly group = new THREE.Group();
  private readonly body = new THREE.Group(); // tilts and bounces; group stays put
  private readonly holo: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly glyph: THREE.Sprite;
  private readonly beam: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>;
  private readonly spotlight: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly pad: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly current: Targets = { ...STATE.attentive };
  private target: Targets = STATE.attentive;
  private handTarget = 0;
  private hand = 0;
  private speakTarget = 0;
  private speak = 0;
  private glyphTarget = 0;
  private glyphChangedAt = -10;
  private time = Math.random() * 10;
  private readonly still = reducedMotion();

  constructor(
    readonly cadetId: string,
    readonly seat: number,
    readonly accent: number,
    seed: number,
  ) {
    const pose = seatPose(seat);
    this.group.position.copy(pose.position);
    this.group.rotation.y = pose.facing;
    const accentColor = new THREE.Color(accent);

    this.holo = new THREE.Mesh(
      quad,
      new THREE.ShaderMaterial({
        vertexShader: vert,
        fragmentShader: frag,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uAccent: { value: accentColor },
          uTime: { value: 0 },
          uBrightness: { value: 1 },
          uFlicker: { value: 0.02 },
          uSweepPeriod: { value: 4 + (seed % 1000) / 333 },
          uSweepOffset: { value: (seed % 97) / 13 },
          uSkeptic: { value: 0 },
          uSpeaking: { value: 0 },
          uHasPortrait: { value: 0 },
          uPortrait: { value: null },
          uSeed: { value: seed % 1000 },
        },
      }),
    );
    // Stands just behind its console, rising from the seat projector.
    this.body.position.set(0, 0.12, -0.12);
    this.body.add(this.holo);

    this.glyph = new THREE.Sprite(
      new THREE.SpriteMaterial({
        color: accentColor.clone().multiplyScalar(1.5),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.glyph.position.set(0.3, BILLBOARD_H + 0.02, 0.02);
    this.glyph.scale.setScalar(0.42);
    this.body.add(this.glyph);

    this.pad = new THREE.Mesh(
      padGeo,
      new THREE.MeshBasicMaterial({
        color: accentColor.clone().multiplyScalar(1.4),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.pad.position.set(0.22, 0.42, 0.12);
    this.pad.rotation.x = -0.9;
    this.body.add(this.pad);

    this.beam = new THREE.Mesh(
      beamGeo,
      new THREE.ShaderMaterial({
        vertexShader: vert,
        fragmentShader: beamFrag,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: { uAccent: { value: accentColor }, uTime: { value: 0 }, uStrength: { value: 0 } },
      }),
    );
    this.beam.position.set(0, 0.6, -0.12);
    this.beam.visible = false;

    this.spotlight = new THREE.Mesh(
      discGeo,
      new THREE.MeshBasicMaterial({
        color: accentColor.clone().multiplyScalar(0.7),
        map: radialTexture(),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.spotlight.position.y = 0.02;

    this.group.add(this.body, this.beam, this.spotlight);
  }

  setState(state: ReactionState, now: number): void {
    if (STATE[state] === this.target) return;
    this.target = STATE[state];
    const glyph = REACTION_GLYPHS[state];
    if (glyph) {
      this.glyph.material.map = glyphTexture(glyph);
      this.glyph.material.needsUpdate = true;
      this.glyphTarget = 1;
      this.glyphChangedAt = now;
    } else this.glyphTarget = 0;
  }

  setHandRaised(on: boolean): void {
    this.handTarget = on ? 1 : 0;
  }

  setSpeaking(on: boolean): void {
    this.speakTarget = on ? 1 : 0;
  }

  /** Keeps the billboard facing the camera (yaw only, never rolls). */
  update(dt: number, camera: THREE.Camera): void {
    this.time += dt;
    const k = 1 - Math.exp(-dt * 6); // ~280ms ease
    for (const key of Object.keys(this.current) as Array<keyof Targets>)
      this.current[key] += (this.target[key] - this.current[key]) * k;
    this.hand += (this.handTarget - this.hand) * k;
    this.speak += (this.speakTarget - this.speak) * k;
    // Glyphs pop, then settle to a quieter presence after 3s.
    const glyphAge = this.time - this.glyphChangedAt;
    const glyphGoal = this.glyphTarget * (glyphAge < 3 ? 1 : 0.35);
    this.glyph.material.opacity += (glyphGoal - this.glyph.material.opacity) * k;

    const c = this.current;
    const motion = this.still ? 0 : 1;
    const bounce = c.bounce * motion * Math.abs(Math.sin(this.time * 6)) * 0.06;
    const drift = c.drift * motion * Math.sin(this.time * 0.7) * 0.05;
    this.body.position.y = 0.12 + bounce + this.speak * 0.06;
    this.body.position.x = drift;
    this.body.rotation.z = c.tilt;
    this.body.rotation.x = -c.lean;
    this.body.scale.setScalar(1 + this.speak * 0.15);

    const u = this.holo.material.uniforms;
    const pulse = c.bounce * motion * 0.12 * Math.sin(this.time * 9);
    u.uTime!.value = this.time;
    u.uBrightness!.value = c.brightness + pulse + this.speak * 0.15;
    u.uFlicker!.value = c.flicker;
    u.uSkeptic!.value = c.skeptic;
    u.uSpeaking!.value = this.speak;
    this.pad.material.opacity = c.pad * (0.55 + (motion ? 0.25 * Math.sin(this.time * 5) : 0));

    this.beam.visible = this.hand > 0.02;
    this.beam.material.uniforms.uStrength!.value = this.hand;
    this.beam.material.uniforms.uTime!.value = this.time;
    this.spotlight.material.opacity = this.speak * 0.7;

    // Yaw-only billboard: undo the seat's facing, then face the camera.
    const toCam = new THREE.Vector3().subVectors(
      camera.position,
      this.group.getWorldPosition(new THREE.Vector3()),
    );
    const yaw = Math.atan2(toCam.x, toCam.z) - this.group.rotation.y;
    this.body.rotation.y = yaw;
  }

  dispose(): void {
    this.holo.material.dispose();
    this.glyph.material.dispose();
    this.pad.material.dispose();
    this.beam.material.dispose();
    this.spotlight.material.dispose();
  }
}
