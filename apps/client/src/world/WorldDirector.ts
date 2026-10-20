import * as THREE from "three";
import { store } from "../core/store";

const ACCENTS = [0x5be7ff, 0xf5c66b, 0xa78bfa, 0x4ade80]; // lumen, aurum, violet, success

/** Owns the Three.js renderer and the active 3D scene. M0: one spinning mesh. */
export class WorldDirector {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  private readonly mesh: THREE.Mesh<THREE.IcosahedronGeometry, THREE.MeshStandardMaterial>;
  private readonly unsubscribe: () => void;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setClearColor(0x05070d, 1);
    this.camera.position.set(0, 0, 4);

    this.mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1, 1),
      new THREE.MeshStandardMaterial({
        color: ACCENTS[0],
        flatShading: true,
        metalness: 0.2,
        roughness: 0.4,
      }),
    );
    this.scene.add(this.mesh);
    this.scene.add(new THREE.AmbientLight(0x7fa8ff, 0.6));
    const key = new THREE.DirectionalLight(0xeaf2ff, 2);
    key.position.set(2, 3, 4);
    this.scene.add(key);

    this.unsubscribe = store.subscribe((s, prev) => {
      if (s.pings !== prev.pings)
        this.mesh.material.color.setHex(ACCENTS[s.pings % ACCENTS.length] ?? 0);
    });
    this.resize();
  }

  resize(): void {
    const { clientWidth: w, clientHeight: h } = this.renderer.domElement;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
  }

  update(_time: number, deltaMs: number): void {
    const dt = deltaMs / 1000;
    this.mesh.rotation.x += dt * 0.4;
    this.mesh.rotation.y += dt * 0.6;
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.unsubscribe();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.renderer.dispose();
  }
}
