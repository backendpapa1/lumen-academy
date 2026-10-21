import * as THREE from "three";
import gasGiantUrl from "../../assets/generated/planet/gas_giant_a.webp";
import planetFrag from "../shaders/planet.frag.glsl?raw";
import planetVert from "../shaders/planet.vert.glsl?raw";
import ringFrag from "../shaders/ring.frag.glsl?raw";
import ringVert from "../shaders/ring.vert.glsl?raw";

// The academy's gas giant and its rings (docs/08 §4). Procedural bands show at
// once; the generated band texture fades in when it has loaded.

const loader = new THREE.TextureLoader();

export class GasGiant {
  readonly group = new THREE.Group();
  private readonly planet: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly ring: THREE.Mesh<THREE.RingGeometry, THREE.ShaderMaterial>;
  private map: THREE.Texture | null = null;
  private mapMix = 0;
  private time = 0;

  constructor(opts: { radius: number; sunDir?: THREE.Vector3; ringTilt?: number }) {
    const r = opts.radius;
    this.planet = new THREE.Mesh(
      new THREE.SphereGeometry(r, 96, 64),
      new THREE.ShaderMaterial({
        vertexShader: planetVert,
        fragmentShader: planetFrag,
        uniforms: {
          uSunDir: { value: opts.sunDir ?? new THREE.Vector3(0.9, 0.35, 0.5) },
          uTime: { value: 0 },
          uBandA: { value: new THREE.Color(0xc9a27a) },
          uBandB: { value: new THREE.Color(0x6e5a8a) },
          uAtmos: { value: new THREE.Color(0x5be7ff) },
          uViewDirW: { value: new THREE.Vector3(0, 0, -1) },
          uMap: { value: null },
          uUseMap: { value: 0 },
        },
      }),
    );
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(r * 1.31, r * 2.23, 160, 1),
      new THREE.ShaderMaterial({
        vertexShader: ringVert,
        fragmentShader: ringFrag,
        uniforms: {
          uColor: { value: new THREE.Color(0xd8c6a8) },
          uInner: { value: r * 1.31 },
          uOuter: { value: r * 2.23 },
        },
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.ring.rotation.x = Math.PI / 2 - (opts.ringTilt ?? 0.25);
    this.ring.rotation.y = 0.32;
    this.planet.add(this.ring);
    this.group.add(this.planet);
    loader.load(gasGiantUrl, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = THREE.RepeatWrapping;
      t.anisotropy = 8;
      this.map = t;
      this.planet.material.uniforms.uMap!.value = t;
    });
  }

  /** The camera's view direction, for the atmosphere rim. */
  lookFrom(camera: THREE.Camera): void {
    camera.getWorldDirection(this.planet.material.uniforms.uViewDirW!.value);
  }

  update(dt: number): void {
    this.time += dt;
    this.planet.rotation.y += dt * 0.006; // slow, calm rotation
    const u = this.planet.material.uniforms;
    u.uTime!.value = this.time;
    if (this.map && this.mapMix < 1) {
      this.mapMix = Math.min(1, this.mapMix + dt / 1.2);
      u.uUseMap!.value = this.mapMix;
    }
  }

  dispose(): void {
    this.planet.geometry.dispose();
    this.planet.material.dispose();
    this.ring.geometry.dispose();
    this.ring.material.dispose();
    this.map?.dispose();
  }
}
