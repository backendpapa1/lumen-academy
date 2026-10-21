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
import { BackdropScene } from "./world/scenes/BackdropScene";
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
let showingWorld: "backdrop" | "classroom" | null = null;
function applyRoute() {
  const route = store.getState().route;
  const key =
    route.name === "classroom" || route.name === "registration"
      ? `${route.name}:${route.classroomId}`
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
  if (route.name === "registration") {
    director.show(new ClassroomScene({ arrivals: true }));
    showingWorld = "classroom";
  } else if (showingWorld !== "backdrop") {
    director.show(new BackdropScene());
    showingWorld = "backdrop";
  }
}
store.subscribe(applyRoute);

if (view === "classroom-demo") {
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
