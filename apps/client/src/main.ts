import * as Phaser from "phaser";
import * as THREE from "three";
import type { ServerMessage } from "@lumen/shared";
import { applyServerMessage } from "./core/classroom";
import { loadDemoClassroom } from "./core/demo";
import { store } from "./core/store";
import { loadFonts } from "./ui/fonts";
import { BootScene } from "./ui/scenes/BootScene";
import { ClassroomHud } from "./ui/scenes/ClassroomHud";
import { GalleryScene } from "./ui/scenes/GalleryScene";
import { ClassroomScene } from "./world/scenes/ClassroomScene";
import { WorldDirector } from "./world/WorldDirector";
import { installKeyboard } from "./core/input";

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

// Route → 3D scene + HUD scene (docs/05 §4.3).
let showing: string | null = null;
function applyRoute() {
  const route = store.getState().route;
  if (route.name === showing) return;
  showing = route.name;
  if (route.name === "classroom") {
    director.show(new ClassroomScene());
    ui.scene.stop("boot");
    ui.scene.start("classroomHud");
  } else if (route.name === "boot") {
    ui.scene.stop("classroomHud");
    ui.scene.start("boot");
  }
}
store.subscribe(applyRoute);

if (view === "classroom-demo") {
  loadDemoClassroom();
  store.setState({ route: { name: "classroom", classroomId: "cls_demo" } });
}
ui.events.once(Phaser.Core.Events.READY, () => {
  if (view !== "gallery") {
    ui.scene.add("boot", BootScene, false);
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
    };
  }
}
window.__lumen = {
  store,
  phaserVersion: Phaser.VERSION,
  threeRevision: THREE.REVISION,
  stats: director.stats,
  receive: (m) => store.setState((s) => ({ classroom: applyServerMessage(s.classroom, m) })),
};
