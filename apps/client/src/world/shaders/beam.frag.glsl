// Hand-raise beam: a soft accent column rising from the seat, scrolling noise.
uniform vec3 uAccent;
uniform float uTime;
uniform float uStrength; // 0..1 fade
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  float edge = 1.0 - abs(vUv.x - 0.5) * 2.0;
  float core = pow(edge, 2.2);
  float scroll = 0.75 + 0.25 * hash(vec2(floor(vUv.x * 14.0), floor(vUv.y * 40.0 - uTime * 18.0)));
  float fade = smoothstep(1.0, 0.55, vUv.y) * smoothstep(0.0, 0.05, vUv.y);
  float a = core * fade * scroll * uStrength * 0.42;  // a thin, soft light, not a pillar
  gl_FragColor = vec4(mix(vec3(1.0), uAccent, 0.6) * 1.3 * a, a);
  #include <colorspace_fragment>
}
