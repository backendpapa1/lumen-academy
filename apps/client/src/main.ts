import * as Phaser from "phaser";
import * as THREE from "three";
import type { ServerMessage } from "@lumen/shared";
import { applyServerMessage } from "./core/classroom";
import { loadDemoClassroom } from "./core/demo";
import { store } from "./core/store";
import { loadFonts } from "./ui/fonts";
import { GalleryScene } from "./ui/scenes/GalleryScene";
import { installScreens } from "./ui/screens";
import { Campus } from "./ui/campus/Campus";
import { campusView, fx, setArena } from "./world/anchors";
import { ExamHall } from "./ui/room/ExamHall";
import { world } from "./world/anchors";
import { WorldDirector } from "./world/WorldDirector";
import { app } from "./core/app";
import { installKeyboard } from "./core/input";
import { installSound, sound } from "./core/audio";
import { statsOverlay } from "./ui/dom/stats";
import { hideRoom, showRoom } from "./ui/room";

const worldCanvas = document.querySelector<HTMLCanvasElement>("#world");
const uiCanvas = document.querySelector<HTMLCanvasElement>("#ui");
const stage = document.querySelector<HTMLDivElement>("#stage");
if (!worldCanvas || !uiCanvas || !stage) throw new Error("index.html is missing #stage/#world/#ui");

const view = new URLSearchParams(location.search).get("view");
await loadFonts();

const director = new WorldDirector(
  new THREE.WebGLRenderer({
    canvas: worldCanvas,
    antialias: true,
    powerPreference: "high-performance",
  }),
);

const ui = new Phaser.Game({
  type: Phaser.WEBGL,
  canvas: uiCanvas,
  parent: stage,
  transparent: true,
  scale: { mode: Phaser.Scale.RESIZE },
  // Scenes start per route (applyRoute), never automatically.
  scene: view === "gallery" ? [GalleryScene] : [],
});

// One RAF, one clock: Phaser's step drives the Three.js world (docs/05 §4.1).
ui.events.on(Phaser.Core.Events.PRE_STEP, (time: number, delta: number) => {
  director.update(time, delta);
  director.render();
});
window.addEventListener("resize", () => director.resize());

// Route → 3D scene + UI layer (docs/05 §4.3). The classroom uses the Phaser
// HUD; setup screens (lobby, School Wing, registration) are DOM (D14).
let showing: string | null = null;
let showingWorld: "campus" | "room" | "arena" | null = null;
let arenaHall: ExamHall | null = null;
function applyRoute() {
  const route = store.getState().route;
  const key =
    route.name === "classroom" || route.name === "registration"
      ? `${route.name}:${route.classroomId}`
      : route.name === "exam"
        ? `exam:${route.examId}`
        : route.name;
  if (key === showing) return;
  showing = key;
  if (route.name === "gallery") return;
  if (route.name !== "exam") {
    setArena(null);
    arenaHall?.dispose();
    arenaHall = null;
  }
  if (route.name === "classroom" || route.name === "registration") {
    // The drawn classroom (ADR-009). Registration fills the same room, so the
    // students stay in their seats when the class starts.
    if (showingWorld !== "room") director.clear();
    showRoom(route.name === "classroom" ? "teaching" : "registration");
    showingWorld = "room";
    campusView.current?.dispose();
    campusView.current = null;
    return;
  }
  hideRoom();
  if (route.name === "exam") {
    // The exam leaves the classroom for the exam hall (M6-09, ADR-009).
    director.clear();
    arenaHall?.dispose();
    arenaHall = new ExamHall(stage!);
    setArena(arenaHall);
    showingWorld = "arena";
  } else if (showingWorld !== "campus") {
    // Lobby, School Wing, desk and debrief all sit over the drawn campus (M5-02, ADR-009).
    director.clear();
    campusView.current = new Campus(stage!);
    showingWorld = "campus";
  }
  if (showingWorld !== "campus" && campusView.current) {
    campusView.current.dispose();
    campusView.current = null;
  }
}
store.subscribe(applyRoute);

if (view !== "gallery") installSound();
if (view === "campus-demo") {
  // Visual check: one wing per tier, 0 Blueprint → 4 Landmark (no server).
  director.clear();
  const campus = new Campus(stage);
  const accents = ["#FFC23D", "#F0442E", "#6B4EFF", "#2A40FF", "#12945C"];
  campus.setWings(
    accents.map((accent, i) => ({
      schoolId: `sch_${i}`,
      slot: i,
      tier: i,
      accent,
      emblemUrl: null,
      decalUrl: null,
    })),
    {},
  );
  store.setState({ route: { name: "gallery" } }); // keep applyRoute from swapping the scene
  const focus = new URLSearchParams(location.search).get("focus");
  if (focus) setTimeout(() => campus.flyTo(`sch_${focus}`), 300);
} else if (view === "classroom-demo") {
  loadDemoClassroom();
  store.setState({ route: { name: "classroom", classroomId: "cls_demo" } });
} else if (view !== "gallery") {
  installScreens();
  app.connect();
  app.rejoin(); // a reload mid-period continues it
}
ui.events.once(Phaser.Core.Events.READY, () => {
  showing = null;
  applyRoute();
  installKeyboard();
});

// Test hooks for Playwright.
declare global {
  interface Window {
    __lumen?: {
      store: typeof store;
      phaserVersion: string;
      threeRevision: string;
      stats: WorldDirector["stats"];
      /** Feed a server message straight into the store (demo/e2e only). */
      receive(m: ServerMessage): void;
      world: typeof world;
      app: typeof app;
      sound: typeof sound;
    };
  }
}
statsOverlay.attach(director.stats);
fx.setBloom = (i) => director.setBloomIntensity(i);
fx.setExposure = (e) => director.setExposure(e);
window.__lumen = {
  store,
  phaserVersion: Phaser.VERSION,
  threeRevision: THREE.REVISION,
  stats: director.stats,
  world,
  app,
  sound,
  receive: (m) => store.setState((s) => ({ classroom: applyServerMessage(s.classroom, m) })),
};
