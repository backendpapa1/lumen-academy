// Dark glass floor with a faint hex grid; a ring ripples out when a cadet speaks
// (docs/08 §4.2).
uniform vec3 uBase;
uniform vec3 uLine;
uniform vec2 uRippleOrigin;
uniform float uRippleAge;   // seconds since the ripple started; < 0 = none
uniform float uScale;
varying vec2 vWorld;

// Distance to the nearest hex edge (0 at the edge).
float hexEdge(vec2 p) {
  p /= uScale;
  const vec2 s = vec2(1.0, 1.7320508);
  vec4 c = floor(vec4(p, p - vec2(0.5, 1.0)) / s.xyxy) + 0.5;
  vec4 h = vec4(p - c.xy * s, p - (c.zw + 0.5) * s);
  vec2 q = dot(h.xy, h.xy) < dot(h.zw, h.zw) ? h.xy : h.zw;
  q = abs(q);
  return 0.5 - max(dot(q, s * 0.5), q.x);
}

void main() {
  float d = length(vWorld);
  float edge = 1.0 - smoothstep(0.0, 0.018, hexEdge(vWorld));
  float fade = exp(-d * 0.16);                       // grid fades into the dark
  vec3 col = uBase + uLine * edge * 0.09 * fade;     // faint: the floor supports, never leads
  if (uRippleAge >= 0.0) {
    float r = uRippleAge * 3.5;
    float ring = exp(-pow((length(vWorld - uRippleOrigin) - r) * 2.5, 2.0));
    float life = clamp(1.0 - uRippleAge / 1.6, 0.0, 1.0);
    col += uLine * ring * life * (0.25 + edge * 0.9);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
