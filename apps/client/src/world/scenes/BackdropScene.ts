import * as THREE from "three";
import nebulaA from "../../assets/generated/nebula/a.webp";
import nebulaB from "../../assets/generated/nebula/b.webp";
import nebulaC from "../../assets/generated/nebula/c.webp";
import { GasGiant } from "../objects/GasGiant";
import type { WorldScene } from "../WorldScene";

// Behind the setup screens (lobby, School Wing, settings): deep space, three
// generated nebula layers drifting at different depths, the academy's gas
// giant low on the right. Quiet on purpose; the UI sits over it.

const loader = new THREE.TextureLoader();

export class BackdropScene implements WorldScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
  private readonly giant = new GasGiant({
    radius: 60,
    sunDir: new THREE.Vector3(-0.7, 0.4, 0.6),
    ringTilt: 0.18,
  });
  private readonly layers: Array<{
    mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
    drift: number;
  }> = [];
  private readonly disposables: Array<{ dispose(): void }> = [];
  private time = 0;

  constructor() {
    this.scene.background = new THREE.Color(0x05070d);
    this.camera.position.set(0, 0, 0);

    // Nebula layers: additive, far to near, each drifting a little.
    const specs: Array<[string, number, number, number]> = [
      // url, distance, opacity, drift speed
      [nebulaA, 900, 0.9, 0.004],
      [nebulaB, 700, 0.55, -0.006],
      [nebulaC, 520, 0.35, 0.009],
    ];
    for (const [url, z, opacity, drift] of specs) {
      const geo = new THREE.PlaneGeometry(z * 2.4, z * 1.6);
      const mat = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(0, 0, -z);
      mesh.userData.targetOpacity = opacity;
      loader.load(url, (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        mat.map = t;
        mat.needsUpdate = true;
        this.disposables.push(t);
      });
      this.scene.add(mesh);
      this.layers.push({ mesh, drift });
      this.disposables.push(geo, mat);
    }

    // Stars: one draw call.
    const n = 2400;
    const pos = new Float32Array(n * 3);
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    for (let i = 0; i < n; i++) {
      const u = rnd() * 2 - 1;
      const t = rnd() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      pos.set([r * Math.cos(t) * 400, u * 400, r * Math.sin(t) * 400], i * 3);
    }
    const starGeo = new THREE.BufferGeometry().setAttribute(
      "position",
      new THREE.BufferAttribute(pos, 3),
    );
    const starMat = new THREE.PointsMaterial({
      color: 0xcfe0ff,
      size: 0.9,
      sizeAttenuation: true,
      toneMapped: false,
    });
    this.scene.add(new THREE.Points(starGeo, starMat));
    this.disposables.push(starGeo, starMat);

    this.giant.group.position.set(150, -95, -330);
    this.giant.group.rotation.z = 0.25;
    this.giant.lookFrom(this.camera);
    this.scene.add(this.giant.group);
  }

  update(dt: number): void {
    this.time += dt;
    for (const l of this.layers) {
      const m = l.mesh.material;
      const target = l.mesh.userData.targetOpacity as number;
      if (m.map && m.opacity < target) m.opacity = Math.min(target, m.opacity + dt * 0.5);
      l.mesh.position.x = Math.sin(this.time * l.drift * 6) * 30;
      l.mesh.rotation.z = this.time * l.drift * 0.2;
    }
    // A slow look-around, a degree or two (docs/08 §4.5: never a roll).
    this.camera.rotation.set(
      Math.sin(this.time * 0.05) * 0.02,
      Math.sin(this.time * 0.037) * 0.03,
      0,
    );
    this.giant.update(dt);
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.giant.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
