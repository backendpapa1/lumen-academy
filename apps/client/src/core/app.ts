import { applyServerMessage, dismissToast } from "./classroom";
import { Net } from "./net";
import { store } from "./store";

// The one place that talks to the server: actions in, server messages applied
// to the store. Phaser, Three and the DOM overlays only read the store and call these.

let net: Net | null = null;
const TOAST_MS = 5000;

function ensureNet(): Net {
  if (net) return net;
  net = new Net(
    (m) => {
      store.setState((s) => ({ classroom: applyServerMessage(s.classroom, m) }));
      if (m.type === "toast" || m.type === "error") {
        const id = store.getState().classroom.toasts.at(-1)?.id;
        if (id !== undefined)
          setTimeout(
            () => store.setState((s) => ({ classroom: dismissToast(s.classroom, id) })),
            TOAST_MS,
          );
      }
    },
    (status) => store.setState({ net: status }),
  );
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
  endClass() {
    store.setState((s) => ({ classroom: { ...s.classroom, status: "ending" } }));
    ensureNet().send("period.end", {});
  },
  backToBoot() {
    store.setState({ route: { name: "boot" } });
  },
};
