// Exam answer beam (docs/08 §4.6): a tapered ribbon of light from a terminal to
// the question card. Pulses travel toward the card; uFlash whitens it on lock.
uniform vec3 uColor;
uniform float uTime;
uniform float uStrength; // 0..1 overall fade
uniform float uFlash;    // 0..1 lock flash
varying vec2 vUv;
void main() {
  // Thin enough that bloom supplies the soft edge; the light is even across it.
  float pulses = 0.7 + 0.3 * sin(vUv.y * 38.0 - uTime * 16.0);
  float ends = smoothstep(0.0, 0.06, vUv.y) * smoothstep(1.0, 0.94, vUv.y);
  float a = ends * pulses * uStrength;
  vec3 c = mix(uColor, vec3(1.0), uFlash * 0.7 + 0.2) * (1.4 + uFlash * 1.6);
  gl_FragColor = vec4(c * a, a);
  #include <colorspace_fragment>
}
