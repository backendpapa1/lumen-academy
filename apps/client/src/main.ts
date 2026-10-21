import type { ServerMessage } from "@lumen/shared";
import { app } from "./core/app";
import { installSound, sound } from "./core/audio";
import { applyServerMessage } from "./core/classroom";
import { loadDemoClassroom } from "./core/demo";
import { frames } from "./core/frames";
import { installKeyboard } from "./core/input";
import { store } from "./core/store";
import { voice } from "./core/voice";
import { Campus } from "./ui/campus/Campus";
import { statsOverlay } from "./ui/dom/stats";
import { loadFonts } from "./ui/fonts";
import { hideRoom, showRoom } from "./ui/room";
import { ExamHall } from "./ui/room/ExamHall";
import { installScreens } from "./ui/screens";
import { campusView, setArena, world } from "./world/anchors";

// The whole game is drawn in the DOM (ADR-009): the campus behind the setup
// screens, the classroom with its HUD, and the exam hall. Each route shows
// one of them; the screens layer sits on top (D14).

const stage = document.querySelector<HTMLDivElement>("#stage");
if (!stage) throw new Error("index.html is missing #stage");

const view = new URLSearchParams(location.search).get("view");
await loadFonts();

type Scene = "campus" | "room" | "hall" | null;
let showing: string | null = null;
let scene: Scene = null;
let hall: ExamHall | null = null;

function show(next: Scene) {
  if (next !== "campus" && campusView.current) {
    campusView.current.dispose();
    campusView.current = null;
  }
  if (next !== "hall" && hall) {
    setArena(null);
    hall.dispose();
    hall = null;
  }
  if (next !== "room") hideRoom();
  scene = next;
}

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
  if (route.name === "classroom" || route.name === "registration") {
    // Registration fills the same room, so the students stay in their seats
    // when the class starts.
    show("room");
    showRoom(route.name === "classroom" ? "teaching" : "registration");
  } else if (route.name === "exam") {
    show("hall");
    hall = new ExamHall(stage!);
    setArena(hall);
  } else if (scene !== "campus") {
    // Lobby, School, Class Desk and debrief sit over the campus (M5-02).
    show("campus");
    campusView.current = new Campus(stage!);
  }
}
store.subscribe(applyRoute);

installSound();
if (view === "campus-demo") {
  // Visual check: one building per tier, 0 Blueprint → 4 Landmark (no server).
  store.setState({ route: { name: "gallery" } }); // keep applyRoute from swapping it
  const campus = new Campus(stage);
  const accents = ["#B86E00", "#D93A26", "#6B4EFF", "#0A7FB0", "#2F8A2F"];
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
  const focus = new URLSearchParams(location.search).get("focus");
  if (focus) setTimeout(() => campus.flyTo(`sch_${focus}`), 300);
} else if (view === "classroom-demo") {
  loadDemoClassroom();
  store.setState({ route: { name: "classroom", classroomId: "cls_demo" } });
} else {
  installScreens();
  app.connect();
  app.rejoin(); // a reload mid-period continues it
}
applyRoute();
installKeyboard();

// Test hooks for Playwright.
declare global {
  interface Window {
    __lumen?: {
      store: typeof store;
      stats: typeof frames;
      /** Feed a server message straight into the store (demo/e2e only). */
      receive(m: ServerMessage): void;
      world: typeof world;
      app: typeof app;
      sound: typeof sound;
      voice: typeof voice;
    };
  }
}
statsOverlay.attach(frames);
window.__lumen = {
  store,
  stats: frames,
  world,
  app,
  sound,
  voice,
  receive: (m) => store.setState((s) => ({ classroom: applyServerMessage(s.classroom, m) })),
};
