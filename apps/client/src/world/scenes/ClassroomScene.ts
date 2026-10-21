import * as THREE from "three";
import type { ClassroomState } from "../../core/classroom";
import { store } from "../../core/store";
import { accentOf } from "../../ui/theme";
import { anchors, world } from "../anchors";
import { dayPhase, PHASES } from "../lighting";
import { Amphitheater, seatPose } from "../objects/Amphitheater";
import { CadetLayer } from "../objects/CadetLayer";
import { HexFloor } from "../objects/HexFloor";
import { HoloBoard } from "../objects/HoloBoard";
import { WindowView } from "../objects/WindowView";
import type { WorldScene } from "../WorldScene";

// The hero scene (docs/02 §3.1, docs/08 §4.2): fixed lectern view with a
// gentle breathing drift, amphitheater ahead, window wall on the left third,
// holo-board on the right. Cadet holograms join in M2-04.

// Lectern view, yawed slightly left so the window fills the left third.
const CAMERA_POS = new THREE.Vector3(0, 2.4, 4.5);
const LOOK_AT = new THREE.Vector3(-1.2, 1.6, -6);

export class ClassroomScene implements WorldScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 600);
  private readonly floor = new HexFloor();
  private readonly amphitheater = new Amphitheater();
  private readonly board = new HoloBoard();
  private readonly cadetLayer = new CadetLayer();
  private readonly windowView: WindowView;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly unsubscribe: () => void;
  private time = 0;
  private lastSpeechId: string | null = null;
  private speakerId: string | null = null;
  private readonly size = { w: 1, h: 1 };
  private readonly head = new THREE.Vector3();
  private readonly ray = new THREE.Raycaster();

  /** arrivals: cadets materialize as they join (registration). */
  constructor(opts: { arrivals?: boolean } = {}) {
    this.cadetLayer.materializeNew = !!opts.arrivals;
    this.scene.background = new THREE.Color(0x05070d);
    this.scene.fog = new THREE.FogExp2(0x05070d, 0.018);
    this.camera.position.copy(CAMERA_POS);
    this.camera.lookAt(LOOK_AT);
    this.windowView = new WindowView(this.camera);

    const phase = PHASES[dayPhase()];
    const key = new THREE.DirectionalLight(phase.key, phase.keyIntensity * 1.3);
    key.position.set(-6, 9, 4); // from the window side
    const fill = new THREE.HemisphereLight(phase.ambient, 0x0b1020, phase.ambientIntensity * 2);
    const front = new THREE.PointLight(0xbfefff, 9, 18, 1.6); // the lectern's soft glow on the class
    front.position.set(0, 2.2, -1);
    this.scene.add(key, fill, front);

    // Centre of the back wall, above the top row's heads (~3.3m): the class
    // faces it, nothing hides it, and the HUD's right rail stays clear.
    this.board.group.position.set(0.4, 4.55, -10.4);
    this.board.group.lookAt(CAMERA_POS.x, 4.55, CAMERA_POS.z);
    this.board.group.scale.setScalar(1.15);
    this.scene.add(
      this.floor.mesh,
      this.amphitheater.group,
      this.cadetLayer.group,
      this.board.group,
      this.windowView.group,
      this.backWall(),
    );

    this.unsubscribe = store.subscribe((s, prev) => {
      if (s.classroom !== prev.classroom) this.sync(s.classroom, prev.classroom);
      if (
        s.classroom !== prev.classroom ||
        s.hoveredId !== prev.hoveredId ||
        s.selectedId !== prev.selectedId
      )
        this.cadetLayer.highlight(s.hoveredId, s.selectedId);
    });
    this.sync(store.getState().classroom, null);
    world.pick = this.pick;
  }

  /** Curved back wall behind the top tier with slow-pulsing light strips (docs/08 §4.1). */
  private backWall(): THREE.Group {
    const g = new THREE.Group();
    // Arc stops short on the left so the window wall gets the left third.
    const wallGeo = new THREE.CylinderGeometry(11.2, 11.2, 7, 64, 1, true, Math.PI - 0.95, 1.55);
    const wall = new THREE.Mesh(
      wallGeo,
      new THREE.MeshStandardMaterial({
        color: 0x0b1020,
        roughness: 0.6,
        metalness: 0.2,
        side: THREE.BackSide,
      }),
    );
    wall.position.y = 3.2;
    const stripMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0x5be7ff).multiplyScalar(0.7),
      toneMapped: false,
      side: THREE.BackSide,
    });
    for (const y of [1.2, 5.4]) {
      const strip = new THREE.Mesh(
        new THREE.CylinderGeometry(11.15, 11.15, 0.03, 64, 1, true, Math.PI - 0.95, 1.55),
        stripMat,
      );
      strip.position.y = y;
      g.add(strip);
      this.disposables.push(strip.geometry);
    }
    g.add(wall);
    // Ceiling: space is only seen through the window, never over the room.
    const ceilingGeo = new THREE.CircleGeometry(16, 64);
    const ceiling = new THREE.Mesh(
      ceilingGeo,
      new THREE.MeshStandardMaterial({ color: 0x080b16, roughness: 0.8, side: THREE.DoubleSide }),
    );
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.y = 6.7;
    g.add(ceiling);
    this.disposables.push(ceilingGeo, ceiling.material as THREE.Material);
    g.userData.stripMat = stripMat;
    this.disposables.push(wallGeo, wall.material as THREE.Material, stripMat);
    return g;
  }

  private sync(c: ClassroomState, prev: ClassroomState | null): void {
    if (!prev || c.cadets !== prev.cadets) {
      this.amphitheater.setOccupancy(
        new Map(Object.values(c.cadets).map((x) => [x.seat, accentOf(x.archetype)])),
      );
    }
    this.cadetLayer.sync(c);
    const lastPoint =
      [...c.transcript].reverse().find((t) => t.speaker === "headmaster")?.text ?? "";
    this.board.set({
      concept: c.concept?.title ?? "",
      point: lastPoint,
      understanding: c.classAverage,
    });
    this.speakerId = c.speech?.cadetId ?? null;
    // A cadet starting to speak sends a ripple across the floor from their seat.
    const speaking = c.speech && !c.speech.done ? c.speech : null;
    if (speaking && speaking.streamId !== this.lastSpeechId) {
      this.lastSpeechId = speaking.streamId;
      const cadet = c.cadets[speaking.cadetId];
      if (cadet) this.floor.ripple(seatPose(cadet.seat).position);
    }
  }

  update(dt: number): void {
    this.time += dt;
    // Breathing drift: a few centimetres, never a roll (docs/08 §4.5).
    this.camera.position.set(
      CAMERA_POS.x + Math.sin(this.time * 0.21) * 0.05,
      CAMERA_POS.y + Math.sin(this.time * 0.33) * 0.025,
      CAMERA_POS.z,
    );
    this.camera.lookAt(LOOK_AT);
    this.floor.update(dt);
    this.cadetLayer.update(dt, this.camera);
    this.windowView.update(dt);
    this.projectSpeaker();
  }

  private readonly pick = (x: number, y: number): string | null => {
    this.camera.updateMatrixWorld();
    this.ray.setFromCamera(
      new THREE.Vector2((x / this.size.w) * 2 - 1, 1 - (y / this.size.h) * 2),
      this.camera,
    );
    return this.cadetLayer.pick(this.ray);
  };

  /** Where the speech panel attaches: the speaker's head, in stage pixels. */
  private projectSpeaker(): void {
    const h = this.speakerId ? this.cadetLayer.get(this.speakerId) : undefined;
    if (!h) {
      anchors.speaker = null;
      return;
    }
    this.camera.updateMatrixWorld();
    const p = h.headWorld(this.head).project(this.camera);
    anchors.speaker =
      p.z < 1 ? { x: ((p.x + 1) / 2) * this.size.w, y: ((1 - p.y) / 2) * this.size.h } : null;
  }

  resize(width: number, height: number): void {
    this.size.w = width;
    this.size.h = height;
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    anchors.speaker = null;
    if (world.pick === this.pick) world.pick = null; // a newer scene may already own it
    this.unsubscribe();
    this.floor.dispose();
    this.amphitheater.dispose();
    this.cadetLayer.dispose();
    this.board.dispose();
    this.windowView.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
