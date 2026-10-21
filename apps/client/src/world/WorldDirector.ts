import {
  BloomEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  VignetteEffect,
} from "postprocessing";
import * as THREE from "three";
import type { WorldScene } from "./WorldScene";

const MAX_DPR = 1.5;
const SLOW_FRAME_MS = 20;
const SLOW_FOR_MS = 2000;

/**
 * Owns the Three.js renderer, the post-processing chain and the active 3D
 * scene (docs/05 §4). Adaptive DPR: drop to 1.0 after 2s of slow frames.
 */
export class WorldDirector {
  private composer: EffectComposer;
  private active: WorldScene | null = null;
  private bloom: BloomEffect;
  private slowFor = 0;
  private dpr = Math.min(window.devicePixelRatio, MAX_DPR);
  readonly stats = { fps: 60, frameMs: 16.7, drawCalls: 0, triangles: 0, dpr: this.dpr };

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    renderer.setPixelRatio(this.dpr);
    renderer.setClearColor(0x05070d, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
    this.bloom = new BloomEffect({
      luminanceThreshold: 0.75,
      luminanceSmoothing: 0.2,
      intensity: 0.9,
      mipmapBlur: true,
    });
  }

  show(scene: WorldScene): void {
    this.active?.dispose();
    this.active = scene;
    this.renderer.domElement.style.visibility = "";
    this.composer.removeAllPasses();
    this.composer.addPass(new RenderPass(scene.scene, scene.camera));
    this.composer.addPass(
      new EffectPass(
        scene.camera,
        this.bloom,
        new VignetteEffect({ offset: 0.35, darkness: 0.55 }),
        new SMAAEffect(),
      ),
    );
    this.resize();
  }

  /** No 3D world: the illustrated scenes (ADR-009) draw in the DOM instead. */
  clear(): void {
    this.active?.dispose();
    this.active = null;
    this.composer.removeAllPasses();
    this.renderer.domElement.style.visibility = "hidden";
  }

  /** Hyperfocus (docs/08 §1): bloom −40%. */
  setBloomIntensity(i: number): void {
    this.bloom.intensity = i;
  }

  /** Whole-frame brightness, as a compositor filter so it holds through post-processing. */
  setExposure(e: number): void {
    const el = this.renderer.domElement;
    el.style.filter = e >= 0.999 ? "" : `brightness(${e.toFixed(2)})`;
  }

  resize(): void {
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h, false);
    this.active?.resize(w, h);
  }

  private lastFrameAt = 0;

  update(time: number, deltaMs: number): void {
    // Phaser smooths and clamps its delta, which hides slow frames; measure
    // the real interval for the stats, adaptive DPR and animation.
    const now = performance.now();
    const realMs = this.lastFrameAt ? now - this.lastFrameAt : deltaMs;
    this.lastFrameAt = now;
    const dt = Math.min(realMs, 100) / 1000;
    this.stats.frameMs = this.stats.frameMs * 0.9 + realMs * 0.1;
    this.stats.fps = 1000 / this.stats.frameMs;
    this.adaptDpr(realMs);
    this.active?.update(dt, time / 1000);
  }

  render(): void {
    if (!this.active) return;
    this.renderer.info.autoReset = false;
    this.renderer.info.reset();
    this.composer.render();
    this.stats.drawCalls = this.renderer.info.render.calls;
    this.stats.triangles = this.renderer.info.render.triangles;
  }

  private adaptDpr(deltaMs: number): void {
    if (this.dpr <= 1) return;
    this.slowFor = deltaMs > SLOW_FRAME_MS ? this.slowFor + deltaMs : 0;
    if (this.slowFor > SLOW_FOR_MS) {
      this.dpr = 1;
      this.stats.dpr = 1;
      this.slowFor = 0;
      this.resize();
    }
  }

  dispose(): void {
    this.active?.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}
