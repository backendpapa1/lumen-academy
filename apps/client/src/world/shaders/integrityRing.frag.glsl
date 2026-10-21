// Class Integrity as an arc of light on the arena floor (docs/02 §5.2): fills
// clockwise from the front; the pass mark is a gold notch.
uniform float uFill;     // 0..1 shown value
uniform float uPass;     // 0..1 pass mark
uniform float uInner;
uniform float uOuter;
uniform float uTime;
uniform vec3 uLumen;
uniform vec3 uAurum;
uniform vec3 uTrack;
varying vec2 vPos;
const float TAU = 6.28318530718;
void main() {
  float r = length(vPos);
  float t = (r - uInner) / (uOuter - uInner);
  // Angle from the front (towards the camera, +y in ring space), clockwise.
  float ang = fract(atan(vPos.x, vPos.y) / TAU + 1.0);
  float band = smoothstep(0.0, 0.12, t) * smoothstep(1.0, 0.88, t);
  float lit = step(ang, uFill);
  float head = smoothstep(0.035, 0.0, abs(ang - uFill)) * step(0.001, uFill);
  vec3 fillColor = uFill >= uPass ? uAurum : uLumen;
  float shimmer = 0.85 + 0.15 * sin(ang * 90.0 - uTime * 3.0);
  vec3 c = uTrack * 0.6 + fillColor * lit * 1.5 * shimmer + vec3(1.0) * head * 1.2;
  float a = band * (0.28 + lit * 0.62 + head * 0.4);
  // Pass-mark notch, brighter across the full width of the band.
  float notch = smoothstep(0.006, 0.0, abs(ang - uPass));
  c = mix(c, uAurum * 2.0, notch);
  a = max(a, notch * smoothstep(-0.2, 0.2, t) * smoothstep(1.2, 0.8, t));
  gl_FragColor = vec4(c * a, a);
  #include <colorspace_fragment>
}
