// Procedural gas giant: latitude bands with turbulence, lit by a distant sun,
// atmosphere rim. Textures from the asset pipeline replace the bands in M3.
uniform vec3 uSunDir;
uniform float uTime;
uniform vec3 uBandA;
uniform vec3 uBandB;
uniform vec3 uAtmos;
uniform vec3 uViewDirW;
varying vec3 vNormalW;
varying vec3 vPos;

float hash(vec3 p) { return fract(sin(dot(p, vec3(17.1, 113.7, 41.3))) * 43758.5453); }
float noise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}

void main() {
  vec3 p = normalize(vPos);
  float lat = p.y;
  float swirl = noise(vec3(p.x * 3.0 + uTime * 0.01, lat * 18.0, p.z * 3.0)) * 0.35;
  float bands = 0.5 + 0.5 * sin(lat * 22.0 + swirl * 6.0);
  vec3 col = mix(uBandA, uBandB, bands);
  col *= 0.85 + 0.3 * noise(p * 9.0);
  float light = clamp(dot(vNormalW, normalize(uSunDir)) * 1.1 + 0.05, 0.0, 1.0);
  float rim = pow(1.0 - clamp(dot(vNormalW, -normalize(uViewDirW)), 0.0, 1.0), 3.0);
  vec3 outCol = col * light + uAtmos * rim * (0.35 + light * 0.9);
  gl_FragColor = vec4(outCol, 1.0);
  #include <colorspace_fragment>
}
