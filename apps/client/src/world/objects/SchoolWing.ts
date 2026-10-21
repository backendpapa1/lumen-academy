import * as THREE from "three";

// One School's building on the campus (docs/02 §7.3, docs/08 §4.1), built from
// a small procedural kit of stacked, bevelled modules. Tiers:
// 0 Blueprint (wireframe) · 1 Frame (base + scaffold) · 2 Wing (solid hull, lit
// windows or the generated decal) · 3 Tower (crown + emblem) · 4 Landmark
// (spire, beacon to the sky, orbiting particles).

const loader = new THREE.TextureLoader();

/** A rounded-rectangle footprint extruded to a height, with a soft bevel. */
function moduleGeo(w: number, d: number, h: number, r = 0.6): THREE.ExtrudeGeometry {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -d / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + d - r);
  s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  s.lineTo(x + r, y + d);
  s.quadraticCurveTo(x, y + d, x, y + d - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: h,
    bevelEnabled: true,
    bevelSize: 0.18,
    bevelThickness: 0.18,
    bevelSegments: 2,
    curveSegments: 6,
  });
  g.rotateX(-Math.PI / 2); // extrude upward
  return g;
}

/** Rows of warm and cool windows on a dark facade, until a generated decal arrives. */
let windowTex: THREE.CanvasTexture | null = null;
function windowsTexture(): THREE.CanvasTexture {
  if (windowTex) return windowTex;
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = "#0b1020";
  g.fillRect(0, 0, 256, 256);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let row = 0; row < 16; row++)
    for (let col = 0; col < 12; col++) {
      if (rnd() < 0.35) continue;
      const lit = rnd();
      g.fillStyle =
        lit > 0.8
          ? "rgba(245,198,107,0.95)"
          : lit > 0.4
            ? "rgba(91,231,255,0.8)"
            : "rgba(140,180,255,0.35)";
      g.fillRect(8 + col * 20, 6 + row * 16, 12, 6);
    }
  windowTex = new THREE.CanvasTexture(c);
  windowTex.colorSpace = THREE.SRGBColorSpace;
  windowTex.wrapS = windowTex.wrapT = THREE.RepeatWrapping;
  // Extrude UVs are in world units: one texture per ~8 units of facade.
  windowTex.repeat.set(0.13, 0.11);
  return windowTex;
}

interface Part {
  mesh: THREE.Object3D;
  /** The tier from which this part is built (solid). */
  from: number;
}

export class SchoolWing {
  readonly group = new THREE.Group();
  private readonly parts: Part[] = [];
  private readonly wire: THREE.LineSegments;
  private readonly beam: THREE.Mesh;
  private readonly halo: THREE.Points;
  private readonly emblem: THREE.Sprite;
  private readonly drones: THREE.Points;
  private readonly facade: THREE.MeshStandardMaterial;
  private readonly accent: THREE.Color;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private tier = -1;
  private grow = 1; // 0..1 tier-up animation
  private flash = 0;
  private time = Math.random() * 10;
  /** Where to look at this wing from (for the fly-to camera). */
  readonly focus = new THREE.Vector3();

  constructor(accent: string) {
    this.accent = new THREE.Color(accent);
    const white = new THREE.MeshStandardMaterial({
      color: 0xdfe6ef,
      roughness: 0.35,
      metalness: 0.1,
    });
    const graphite = new THREE.MeshStandardMaterial({
      color: 0x1b2233,
      roughness: 0.5,
      metalness: 0.5,
    });
    this.facade = new THREE.MeshStandardMaterial({
      color: 0x9aa6b8,
      roughness: 0.4,
      metalness: 0.2,
      emissive: 0xffffff,
      emissiveMap: windowsTexture(),
      emissiveIntensity: 0.9,
      map: windowsTexture(),
    });
    const edge = new THREE.MeshBasicMaterial({
      color: this.accent.clone().multiplyScalar(1.4),
      toneMapped: false,
    });
    this.disposables.push(white, graphite, this.facade, edge);

    // Pad: a hex platform with an accent rim (always there, even as a blueprint).
    const padGeo = new THREE.CylinderGeometry(7, 7.4, 0.6, 6);
    const pad = new THREE.Mesh(padGeo, graphite);
    pad.position.y = 0.3;
    const rimGeo = new THREE.TorusGeometry(7.15, 0.08, 6, 6);
    rimGeo.rotateX(Math.PI / 2);
    const rim = new THREE.Mesh(rimGeo, edge);
    rim.position.y = 0.62;
    this.group.add(pad, rim);
    this.disposables.push(padGeo, rimGeo);

    // The stack: base (tier 1), mid (tier 2, windows), crown (tier 3), spire (tier 4).
    // [geometry, material, base height, tier, blueprint outline w × h × d]
    const stack: Array<
      [THREE.BufferGeometry, THREE.Material, number, number, [number, number, number]]
    > = [
      [moduleGeo(9, 7, 5), white, 0.6, 1, [9.4, 5.4, 7.4]],
      [moduleGeo(7.5, 5.8, 9), this.facade, 5.9, 2, [7.9, 9.4, 6.2]],
      [moduleGeo(5.2, 4, 4.5), white, 15.2, 3, [5.6, 4.9, 4.4]],
      [new THREE.ConeGeometry(0.9, 9, 6), graphite, 24.2, 4, [0, 0, 0]],
    ];
    const wireGeos: THREE.BufferGeometry[] = [];
    for (const [geo, mat, y, from, box] of stack) {
      const m = new THREE.Mesh(geo, mat);
      if (geo instanceof THREE.ConeGeometry) m.position.y = y;
      else m.position.y = y;
      if (geo instanceof THREE.ConeGeometry) geo.translate(0, 4.5, 0);
      this.group.add(m);
      this.parts.push({ mesh: m, from });
      this.disposables.push(geo);
      // Blueprint: a clean outline (box edges; the cone's own edges for the spire).
      const outline = box[0] ? new THREE.BoxGeometry(...box) : geo;
      const e = new THREE.EdgesGeometry(outline, 30);
      e.translate(0, y + (box[0] ? box[1] / 2 - 0.2 : 0), 0);
      if (outline !== geo) outline.dispose();
      wireGeos.push(e);
    }
    // Accent light strips between modules (pulse slowly, docs/08 §4.1).
    for (const [y, from, w] of [
      [5.75, 1, 9.3],
      [15.05, 2, 7.8],
      [19.85, 3, 5.5],
    ] as const) {
      const g = bandGeo(w, w * 0.78, 0.22, 0.14);
      const strip = new THREE.Mesh(g, edge);
      strip.position.y = y;
      this.group.add(strip);
      this.parts.push({ mesh: strip, from });
      this.disposables.push(g);
    }
    // Blueprint wireframe of the whole tower.
    const merged = mergeLines(wireGeos);
    this.wire = new THREE.LineSegments(
      merged,
      new THREE.LineBasicMaterial({
        color: this.accent.clone().lerp(new THREE.Color(0x5be7ff), 0.5),
        transparent: true,
        opacity: 0.55,
        toneMapped: false,
      }),
    );
    this.group.add(this.wire);
    this.disposables.push(merged, this.wire.material as THREE.Material, ...wireGeos);

    // Beacon (tier 4): a thin column of light to the sky.
    const beamGeo = new THREE.CylinderGeometry(0.25, 0.6, 120, 12, 1, true);
    beamGeo.translate(0, 60 + 33, 0);
    this.beam = new THREE.Mesh(
      beamGeo,
      new THREE.MeshBasicMaterial({
        color: this.accent.clone().multiplyScalar(1.6),
        transparent: true,
        opacity: 0.35,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.group.add(this.beam);
    this.disposables.push(beamGeo, this.beam.material as THREE.Material);

    // Orbiting particles (tier 4) and service drones (tier 1+).
    this.halo = ring(140, 11, this.accent, 0.5);
    this.halo.position.y = 22;
    this.drones = ring(3, 9, new THREE.Color(0xe6edf7), 1.6);
    this.drones.position.y = 8;
    this.group.add(this.halo, this.drones);
    this.disposables.push(
      this.halo.geometry,
      this.halo.material as THREE.Material,
      this.drones.geometry,
      this.drones.material as THREE.Material,
    );

    // Emblem projected above the crown (tier 3+).
    this.emblem = new THREE.Sprite(
      new THREE.SpriteMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.emblem.scale.setScalar(6);
    this.emblem.position.y = 30;
    this.group.add(this.emblem);
    this.disposables.push(this.emblem.material);

    this.focus.set(0, 12, 0);
  }

  setEmblem(url: string | null): void {
    if (!url) return;
    loader.load(url, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      this.emblem.material.map = t;
      this.emblem.material.needsUpdate = true;
      this.disposables.push(t);
    });
  }

  /** The generated facade decal for tiers 2–4 replaces the procedural windows. */
  setDecal(url: string | null): void {
    if (!url) return;
    loader.load(url, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(0.13, 0.11);
      this.facade.map = t;
      this.facade.emissiveMap = t;
      this.facade.emissiveIntensity = 0.55;
      this.facade.needsUpdate = true;
      this.disposables.push(t);
    });
  }

  /** Show a tier; `animate` plays the tier-up build (modules rise, a flash). */
  setTier(tier: number, animate = false): void {
    if (tier === this.tier) return;
    this.tier = tier;
    this.grow = animate ? 0 : 1;
    if (animate) this.flash = 1;
  }

  update(dt: number): void {
    this.time += dt;
    if (this.grow < 1) this.grow = Math.min(1, this.grow + dt / 2.2);
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt / 1.6);
    const ease = 1 - (1 - this.grow) ** 3;
    for (const p of this.parts) {
      const solid = this.tier >= p.from;
      p.mesh.visible = solid;
      // The newest module rises into place during a tier-up.
      const rising = solid && p.from === this.tier && this.grow < 1;
      p.mesh.scale.y = rising ? Math.max(0.001, ease) : 1;
    }
    const wireMat = this.wire.material as THREE.LineBasicMaterial;
    this.wire.visible = this.tier < 2;
    wireMat.opacity = (this.tier === 0 ? 0.6 : 0.3) * (0.75 + 0.25 * Math.sin(this.time * 1.3));
    this.drones.visible = this.tier >= 1;
    this.drones.rotation.y = this.time * 0.5;
    this.halo.visible = this.tier >= 4;
    this.halo.rotation.y = -this.time * 0.15;
    this.beam.visible = this.tier >= 4;
    const em = this.emblem.material;
    // Only once there's an emblem to show (an untextured sprite is a white square).
    em.opacity += ((this.tier >= 3 && em.map ? 0.95 : 0) - em.opacity) * Math.min(1, dt * 2);
    this.emblem.visible = em.opacity > 0.01;
    this.emblem.position.y = 30 + Math.sin(this.time * 0.8) * 0.4;
    this.facade.emissiveIntensity =
      (this.facade.emissiveMap === windowTex ? 0.9 : 0.55) *
        (0.9 + 0.1 * Math.sin(this.time * 1.26)) +
      this.flash * 2;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

/** A thin rectangular band (a frame with a hole), lying flat: the light strip at a module's edge. */
function bandGeo(w: number, d: number, thickness: number, h: number): THREE.ExtrudeGeometry {
  const outer = new THREE.Shape();
  outer.moveTo(-w / 2, -d / 2);
  outer.lineTo(w / 2, -d / 2);
  outer.lineTo(w / 2, d / 2);
  outer.lineTo(-w / 2, d / 2);
  outer.closePath();
  const iw = w / 2 - thickness;
  const id = d / 2 - thickness;
  const hole = new THREE.Path();
  hole.moveTo(-iw, -id);
  hole.lineTo(-iw, id);
  hole.lineTo(iw, id);
  hole.lineTo(iw, -id);
  hole.closePath();
  outer.holes.push(hole);
  const g = new THREE.ExtrudeGeometry(outer, { depth: h, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  return g;
}

function ring(n: number, radius: number, color: THREE.Color, size: number): THREE.Points {
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = radius * (0.92 + ((i * 37) % 17) / 100);
    pos.set([Math.cos(a) * r, ((i * 13) % 7) / 7 - 0.5, Math.sin(a) * r], i * 3);
  }
  const geo = new THREE.BufferGeometry().setAttribute(
    "position",
    new THREE.BufferAttribute(pos, 3),
  );
  return new THREE.Points(
    geo,
    new THREE.PointsMaterial({
      color: color.clone().multiplyScalar(1.5),
      size,
      sizeAttenuation: true,
      toneMapped: false,
      transparent: true,
      opacity: 0.9,
    }),
  );
}

function mergeLines(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const arrays = geos.map((g) => g.getAttribute("position").array as Float32Array);
  const out = new Float32Array(arrays.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrays) {
    out.set(a, o);
    o += a.length;
  }
  return new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(out, 3));
}
