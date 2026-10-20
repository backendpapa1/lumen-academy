import * as Phaser from "phaser";
import * as THREE from "three";
import { bus } from "./core/bus";
import { store } from "./core/store";
import { loadFonts } from "./ui/fonts";
import { BootScene } from "./ui/scenes/BootScene";
import { GalleryScene } from "./ui/scenes/GalleryScene";
import { WorldDirector } from "./world/WorldDirector";

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
  scene: view === "gallery" ? [GalleryScene] : [BootScene],
});

// One RAF, one clock: Phaser's step drives the Three.js world (docs/05 §4.1).
ui.events.on(Phaser.Core.Events.PRE_STEP, (time: number, delta: number) => {
  director.update(time, delta);
  director.render();
});
window.addEventListener("resize", () => director.resize());

bus.on("ui:ping", () => store.setState((s) => ({ pings: s.pings + 1 })));

// Test hook for the Playwright smoke test.
declare global {
  interface Window {
    __lumen?: { store: typeof store; phaserVersion: string; threeRevision: string };
  }
}
window.__lumen = { store, phaserVersion: Phaser.VERSION, threeRevision: THREE.REVISION };
