import type { ServerMessage } from "@lumen/shared";
import { applyServerMessage, dismissToast } from "./classroom";
import { Net } from "./net";
import { store } from "./store";

// The one place that talks to the server: actions in, server messages applied
// to the store. Phaser, Three and the DOM overlays only read the store and call these.

let net: Net | null = null;
const TOAST_MS = 5000;

// The classroom you're in survives a reload: reopening the tab rejoins it,
// and the server picks the unfinished period back up (paused).
const LAST_CLASS_KEY = "lumen.liveClassroom";
const remember = (id: string | null) => {
  try {
    if (id) localStorage.setItem(LAST_CLASS_KEY, id);
    else localStorage.removeItem(LAST_CLASS_KEY);
  } catch {
    /* storage blocked: reload just returns to the class picker */
  }
};

function receive(m: ServerMessage) {
  const wasStarting = store.getState().classroom.status === "starting";
  store.setState((s) => ({ classroom: applyServerMessage(s.classroom, m) }));
  // A class that can't start (archived, no cadets…) sends you back to the picker.
  if (m.type === "error" && wasStarting) {
    remember(null);
    store.setState({ route: { name: "boot" } });
  }
  if (m.type === "period.started") remember(m.payload.classroom.id);
  if (m.type === "period.ended") remember(null);
  if (m.type === "toast" || m.type === "error") {
    const id = store.getState().classroom.toasts.at(-1)?.id;
    if (id !== undefined)
      setTimeout(
        () => store.setState((s) => ({ classroom: dismissToast(s.classroom, id) })),
        TOAST_MS,
      );
  }
}

function ensureNet(): Net {
  if (net) return net;
  net = new Net(receive, (status) => store.setState({ net: status }));
  net.connect();
  return net;
}

export const app = {
  startClass(classroomId: string, opts: { minutes?: number; conceptId?: string } = {}) {
    store.setState((s) => ({
      route: { name: "classroom", classroomId },
      classroom: { ...s.classroom, status: "starting" },
    }));
    ensureNet().send("period.start", { classroomId, ...opts });
  },
  teach(text: string) {
    const t = text.trim();
    if (!t || store.getState().classroom.status !== "live") return;
    store.setState((s) => ({
      classroom: { ...s.classroom, lastSendAt: Date.now(), thinking: true },
    }));
    ensureNet().send("teach.message", { text: t });
  },
  call(cadetId: string) {
    ensureNet().send("hand.call", { cadetId });
  },
  setConcept(conceptId: string) {
    ensureNet().send("concept.set", { conceptId });
  },
  pause() {
    if (store.getState().classroom.status === "live") ensureNet().send("period.pause", {});
  },
  resume() {
    if (store.getState().classroom.status === "live") ensureNet().send("period.resume", {});
  },
  togglePause() {
    if (store.getState().classroom.clock.paused) this.resume();
    else this.pause();
  },
  /** After a reload: rejoin the classroom that was live, if any. */
  rejoin(): boolean {
    let id: string | null;
    try {
      id = localStorage.getItem(LAST_CLASS_KEY);
    } catch {
      return false;
    }
    if (!id) return false;
    this.startClass(id);
    return true;
  },
  endClass() {
    store.setState((s) => ({ classroom: { ...s.classroom, status: "ending" } }));
    ensureNet().send("period.end", {});
  },
  /** A client-side toast, same look and lifetime as the server's. */
  notify(text: string, level: "info" | "warn" | "error" = "info") {
    receive({ type: "toast", payload: { level, text } });
  },
  select(cadetId: string | null) {
    if (store.getState().selectedId !== cadetId) store.setState({ selectedId: cadetId });
  },
  backToBoot() {
    remember(null);
    store.setState({ route: { name: "boot" } });
  },
};
