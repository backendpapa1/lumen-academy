import * as Phaser from "phaser";
import * as THREE from "three";
import type { ServerMessage } from "@lumen/shared";
import { applyServerMessage } from "./core/classroom";
import { loadDemoClassroom } from "./core/demo";
import { store } from "./core/store";
import { loadFonts } from "./ui/fonts";
import { ClassroomHud } from "./ui/scenes/ClassroomHud";
import { GalleryScene } from "./ui/scenes/GalleryScene";
import { installScreens } from "./ui/screens";
import { CampusScene } from "./world/scenes/CampusScene";
import { campusView } from "./world/anchors";
import { ClassroomScene } from "./world/scenes/ClassroomScene";
import { world } from "./world/anchors";
import { WorldDirector } from "./world/WorldDirector";
import { app } from "./core/app";
import { installKeyboard } from "./core/input";
import { statsOverlay } from "./ui/dom/stats";

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
let showingWorld: "campus" | "classroom" | null = null;
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
  if (route.name === "classroom") {
    // Registration already shows this room; keep it so the cadets stay put.
    if (showingWorld !== "classroom") director.show(new ClassroomScene());
    showingWorld = "classroom";
    ui.scene.start("classroomHud");
    return;
  }
  ui.scene.stop("classroomHud");
  if (route.name === "registration" || route.name === "exam") {
    // Registration and the exam both happen in the room itself.
    director.show(new ClassroomScene({ arrivals: route.name === "registration" }));
    showingWorld = "classroom";
  } else if (showingWorld !== "campus") {
    // Lobby, School Wing, desk and debrief all sit over the campus (M5-02).
    campusView.current = new CampusScene();
    director.show(campusView.current);
    showingWorld = "campus";
  }
  if (showingWorld !== "campus") campusView.current = null;
}
store.subscribe(applyRoute);

if (view === "campus-demo") {
  // Visual check: one wing per tier, 0 Blueprint → 4 Landmark (no server).
  const campus = new CampusScene();
  director.show(campus);
  const accents = ["#FFB547", "#FF6B6B", "#A78BFA", "#22D3EE", "#A3E635"];
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
  if (view !== "gallery") {
    ui.scene.add("classroomHud", ClassroomHud, false);
  }
  showing = null;
  applyRoute();
  installKeyboard(ui);
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
    };
  }
}
statsOverlay.attach(director.stats);
window.__lumen = {
  store,
  phaserVersion: Phaser.VERSION,
  threeRevision: THREE.REVISION,
  stats: director.stats,
  world,
  app,
  receive: (m) => store.setState((s) => ({ classroom: applyServerMessage(s.classroom, m) })),
};
