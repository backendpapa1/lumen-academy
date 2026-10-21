import * as THREE from "three";
import { color } from "../../ui/theme";
import frag from "../shaders/integrityRing.frag.glsl?raw";
import vert from "../shaders/integrityRing.vert.glsl?raw";

/** Class Integrity on the floor around the dais: an arc that fills toward the gold pass mark. */
export class IntegrityRing {
  readonly mesh: THREE.Mesh<THREE.RingGeometry, THREE.ShaderMaterial>;
  private target = 0;
  private shown = 0;

  constructor(inner: number, outer: number, pass: number) {
    this.mesh = new THREE.Mesh(
      new THREE.RingGeometry(inner, outer, 160, 1),
      new THREE.ShaderMaterial({
        vertexShader: vert,
        fragmentShader: frag,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uFill: { value: 0 },
          uPass: { value: pass },
          uInner: { value: inner },
          uOuter: { value: outer },
          uTime: { value: 0 },
          uLumen: { value: new THREE.Color(color.lumen) },
          uAurum: { value: new THREE.Color(color.aurum) },
          uTrack: { value: new THREE.Color(color.hull500) },
        },
      }),
    );
    // Lie flat; ring-space +y points at the camera side (+z in the world).
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.rotation.z = Math.PI;
  }

  set(fill: number, pass?: number): void {
    this.target = THREE.MathUtils.clamp(fill, 0, 1);
    if (pass !== undefined) this.mesh.material.uniforms.uPass!.value = pass;
  }

  update(dt: number): void {
    this.shown += (this.target - this.shown) * (1 - Math.exp(-dt * 3));
    const u = this.mesh.material.uniforms;
    u.uFill!.value = this.shown;
    u.uTime!.value += dt;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
