import type * as THREE from "three";

/** A 3D scene the WorldDirector can show (docs/05 §4.3). */
export interface WorldScene {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  update(dt: number, time: number): void;
  resize(width: number, height: number): void;
  dispose(): void;
}
