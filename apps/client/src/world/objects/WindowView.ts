import * as THREE from "three";
import planetFrag from "../shaders/planet.frag.glsl?raw";
import planetVert from "../shaders/planet.vert.glsl?raw";
import ringFrag from "../shaders/ring.frag.glsl?raw";
import ringVert from "../shaders/ring.vert.glsl?raw";

// The window wall (left third of the view): stars, the gas giant and its rings,
// behind curved glass with lumen-edged mullions (docs/08 §4.2).

export class WindowView {
  readonly group = new THREE.Group();
  private readonly planet: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private time = 0;

  constructor(camera: THREE.Camera) {
    // Stars: one draw call.
    const n = 1800;
    const pos = new Float32Array(n * 3);
    const rnd = mulberry(7);
    for (let i = 0; i < n; i++) {
      const u = rnd() * 2 - 1;
      const t = rnd() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      pos.set([r * Math.cos(t) * 220, u * 220, r * Math.sin(t) * 220], i * 3);
    }
    const starGeo = new THREE.BufferGeometry().setAttribute(
      "position",
      new THREE.BufferAttribute(pos, 3),
    );
    const starMat = new THREE.PointsMaterial({
      color: 0xcfe0ff,
      size: 0.6,
      sizeAttenuation: true,
      toneMapped: false,
    });
    this.group.add(new THREE.Points(starGeo, starMat));

    this.planet = new THREE.Mesh(
      new THREE.SphereGeometry(26, 96, 64),
      new THREE.ShaderMaterial({
        vertexShader: planetVert,
        fragmentShader: planetFrag,
        uniforms: {
          uSunDir: { value: new THREE.Vector3(0.9, 0.35, 0.5) },
          uTime: { value: 0 },
          uBandA: { value: new THREE.Color(0xc9a27a) },
          uBandB: { value: new THREE.Color(0x6e5a8a) },
          uAtmos: { value: new THREE.Color(0x5be7ff) },
          uViewDirW: { value: new THREE.Vector3() },
        },
      }),
    );
    // Placed so the camera sees it ~35° left, ~8° up, through the window.
    // ~32° left and ~7° up from the lectern, ~11° across: framed by the window, not filling it.
    this.planet.position.set(-68, 18, -105);
    this.planet.rotation.z = 0.32;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(34, 58, 160, 1),
      new THREE.ShaderMaterial({
        vertexShader: ringVert,
        fragmentShader: ringFrag,
        uniforms: {
          uColor: { value: new THREE.Color(0xd8c6a8) },
          uInner: { value: 34 },
          uOuter: { value: 58 },
        },
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    ring.rotation.x = Math.PI / 2 - 0.25;
    ring.rotation.y = 0.32;
    this.planet.add(ring);
    this.group.add(this.planet);
    camera.getWorldDirection(this.planet.material.uniforms.uViewDirW!.value);

    // Glass + mullions along the left wall.
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry(18, 8),
      new THREE.MeshBasicMaterial({
        color: 0x8cb4ff,
        transparent: true,
        opacity: 0.035,
        depthWrite: false,
      }),
    );
    glass.position.set(-7.2, 3.35, -5);
    glass.rotation.y = Math.PI / 2 - 0.35;
    this.group.add(glass);
    const mullionMat = new THREE.MeshStandardMaterial({
      color: 0x141b2e,
      roughness: 0.5,
      metalness: 0.6,
    });
    const edgeMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0x5be7ff).multiplyScalar(0.9),
      toneMapped: false,
    });
    const mullions = new THREE.InstancedMesh(new THREE.BoxGeometry(0.12, 8, 0.12), mullionMat, 4);
    const edges = new THREE.InstancedMesh(new THREE.BoxGeometry(0.02, 8, 0.02), edgeMat, 4);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 4; i++) {
      // Along the angled glass, starting behind the lectern line so none stands in the foreground.
      const z = -1.5 - i * 3.4;
      const x = -7.2 + (z + 5) * Math.tan(0.35);
      m.makeTranslation(x - 0.06, 3.35, z);
      mullions.setMatrixAt(i, m);
      m.makeTranslation(x + 0.02, 3.35, z);
      edges.setMatrixAt(i, m);
    }
    this.group.add(mullions, edges);
    this.disposables.push(
      starGeo,
      starMat,
      this.planet.geometry,
      this.planet.material,
      ring.geometry,
      ring.material,
      glass.geometry,
      glass.material,
      mullionMat,
      edgeMat,
      mullions,
      edges,
    );
  }

  update(dt: number): void {
    this.time += dt;
    this.planet.rotation.y += dt * 0.006; // slow, calm rotation
    this.planet.material.uniforms.uTime!.value = this.time;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

function mulberry(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
