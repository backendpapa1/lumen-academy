import * as THREE from "three";
import frag from "../shaders/hexFloor.frag.glsl?raw";
import vert from "../shaders/hexFloor.vert.glsl?raw";

/** Dark glass floor with a hex grid that ripples from a speaking cadet (docs/08 §4.2). */
export class HexFloor {
  readonly mesh: THREE.Mesh<THREE.CircleGeometry, THREE.ShaderMaterial>;
  private rippleStart = -1;
  private time = 0;

  constructor() {
    const material = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        uBase: { value: new THREE.Color(0x070a14) },
        uLine: { value: new THREE.Color(0x5be7ff) },
        uRippleOrigin: { value: new THREE.Vector2() },
        uRippleAge: { value: -1 },
        uScale: { value: 0.55 },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.CircleGeometry(30, 64), material);
    this.mesh.rotation.x = -Math.PI / 2;
  }

  ripple(at: THREE.Vector3): void {
    this.mesh.material.uniforms.uRippleOrigin!.value.set(at.x, at.z);
    this.rippleStart = this.time;
  }

  update(dt: number): void {
    this.time += dt;
    const age = this.rippleStart < 0 ? -1 : this.time - this.rippleStart;
    this.mesh.material.uniforms.uRippleAge!.value = age > 1.6 ? -1 : age;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
