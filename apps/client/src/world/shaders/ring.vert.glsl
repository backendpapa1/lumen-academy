varying vec2 vUv2;
varying float vR;
void main() {
  vR = length(position.xy);
  vUv2 = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
