// Cadet hologram (docs/08 §4.3). Until portraits exist (M3) the subject is a
// procedural head-and-shoulders silhouette; uPortrait blends a texture in.
uniform vec3 uAccent;
uniform float uTime;
uniform float uBrightness;   // 1 normal, 0.6 bored, pulses when excited
uniform float uFlicker;      // 0.02 normal, 0.12 confused
uniform float uSweepPeriod;  // 4..7 s, per cadet
uniform float uSweepOffset;
uniform float uSkeptic;      // 0..1 narrowed side vignette
uniform float uSpeaking;     // 0..1 extra rim and lift
uniform float uHasPortrait;  // 0 = silhouette
uniform sampler2D uPortrait;
uniform float uSeed;
varying vec2 vUv;

float hash(float n) { return fract(sin(n) * 43758.5453); }
float sdEllipse(vec2 p, vec2 r) { return (length(p / r) - 1.0) * min(r.x, r.y); }

float sdRoundBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }

// Signed distance to a human bust (uv space, y up): head, jaw, neck, collar,
// broad shoulders tapering into a torso. A placeholder until portraits (M3).
float bust(vec2 uv) {
  vec2 p = uv - vec2(0.5, 0.0);
  float head = sdEllipse(p - vec2(0.0, 0.705), vec2(0.152, 0.19));
  float neck = sdRoundBox(p - vec2(0.0, 0.5), vec2(0.075, 0.07), 0.035);
  // Torso: broad, rounded shoulders tapering slightly toward the waist.
  float halfW = mix(0.35, 0.42, smoothstep(0.0, 0.4, p.y));
  float torso = sdRoundBox(p - vec2(0.0, 0.2), vec2(halfW, 0.22), 0.1);
  float d = smin(smin(head, neck, 0.05), torso, 0.07);
  return d;
}

void main() {
  float d = bust(vUv);
  float mask = 1.0 - smoothstep(-0.004, 0.006, d);
  float rimBand = smoothstep(-0.035, 0.0, d) * mask;         // inner edge glow ("fresnel")
  vec3 base = mix(vec3(0.78, 0.92, 1.0), uAccent, 0.2);       // pale holo light × 20% accent
  vec3 col = base * (0.42 + 0.25 * (1.0 - vUv.y * 0.6));
  if (uHasPortrait > 0.5) {
    vec4 tex = texture2D(uPortrait, vUv);
    col = mix(col, tex.rgb * mix(vec3(1.0), uAccent, 0.2), 0.85);
    mask = max(mask, tex.a);
  }
  col += uAccent * pow(rimBand, 1.6) * (1.4 + uSpeaking * 1.2); // rim, power ~2.5 look
  // Scanlines: 220 lines, 6%, drifting up.
  float scan = 0.94 + 0.06 * sin((vUv.y * 220.0 - uTime * 6.0) * 3.14159);
  col *= scan;
  // Sweep band every few seconds.
  float phase = fract((uTime + uSweepOffset) / uSweepPeriod);
  float sweep = exp(-pow((vUv.y - (1.15 - phase * 1.3)) * 18.0, 2.0));
  col += base * sweep * 0.5;
  // Flicker.
  float n = hash(floor(uTime * 24.0) + uSeed * 31.0);
  col *= 1.0 - uFlicker * n * 1.6;
  // Skeptical: narrowed vignette from the sides.
  float side = smoothstep(0.5 - 0.5 * (1.0 - uSkeptic * 0.45), 0.5, abs(vUv.x - 0.5));
  col *= 1.0 - side * uSkeptic * 0.8;
  // Emitted from the seat projector: fade at the bottom edge.
  float alpha = mask * smoothstep(0.0, 0.22, vUv.y) * uBrightness;
  gl_FragColor = vec4(col * uBrightness, alpha);
  #include <colorspace_fragment>
}
