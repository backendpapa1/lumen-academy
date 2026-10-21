varying vec3 vNormalW;
varying vec3 vPos;
varying vec2 vUv;
void main() {
  vPos = position;
  vUv = uv;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
