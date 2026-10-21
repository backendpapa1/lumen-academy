// Planetary rings: radial bands with gaps, faded by the planet's shadow side.
uniform vec3 uColor;
uniform float uInner;
uniform float uOuter;
varying vec2 vUv2;
varying float vR;
void main() {
  float t = (vR - uInner) / (uOuter - uInner);
  float bands = 0.55 + 0.45 * sin(t * 80.0) * sin(t * 23.0 + 1.3);
  float gap = smoothstep(0.42, 0.45, t) * (1.0 - smoothstep(0.48, 0.5, t));
  float a = (1.0 - gap) * bands * smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.92, 1.0, t)) * 0.55;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}
