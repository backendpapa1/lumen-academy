varying vec3 vNormalW;
varying vec3 vPos;
void main() {
  vPos = position;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
