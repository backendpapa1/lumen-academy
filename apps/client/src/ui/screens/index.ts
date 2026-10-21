import { dismissToast } from "../../core/classroom";
import { store, type AppState } from "../../core/store";
import { fill, h } from "./dom";
import { mountArena } from "./arena";
import { installCampusSync } from "./campusSync";
import { mountDebrief } from "./debrief";
import { mountDesk } from "./desk";
import { mountLobby } from "./lobby";
import { mountRegistration } from "./registration";
import { mountSchool } from "./school";
import { mountStudyHall } from "./studyhall";
import { mountMeeting } from "./meeting";
import { mountProgress } from "./progress";
import "../dom/overlay.css";
import "./screens.css";

// Mounts the DOM screen for the current route (D14: setup screens are DOM,
// the classroom HUD is Phaser). Also shows toasts outside the classroom.

const stage = document.querySelector<HTMLElement>("#stage")!;
const toasts = h("div", { class: "screen-toasts", "aria-live": "polite" });
let current: { key: string; root: HTMLElement; unmount: () => void } | null = null;

function keyOf(r: AppState["route"]): string | null {
  switch (r.name) {
    case "boot":
      return "boot";
    case "school":
      return `school:${r.schoolId}`;
    case "registration":
      return `registration:${r.classroomId}`;
    case "desk":
      return `desk:${r.classroomId}`;
    case "exam":
      return `exam:${r.examId}`;
    case "debrief":
      return `debrief:${r.examId}`;
    case "studyhall":
      return "studyhall";
    case "progress":
      return "progress";
    case "meeting":
      return `meeting:${r.classroomId}`;
    default:
      return null;
  }
}

function mount(r: AppState["route"]) {
  const key = keyOf(r);
  if (current?.key === key) return;
  current?.unmount();
  current?.root.remove();
  current = null;
  if (!key) return;
  const root = h("main", { class: "screen" });
  stage.append(root);
  const unmount =
    r.name === "boot"
      ? mountLobby(root)
      : r.name === "school"
        ? mountSchool(root, r.schoolId)
        : r.name === "registration"
          ? mountRegistration(root, r.classroomId, r.schoolId)
          : r.name === "desk"
            ? mountDesk(root, r.schoolId, r.classroomId)
            : r.name === "exam"
              ? mountArena(root, r.examId, r.classroomId, r.schoolId)
              : r.name === "debrief"
                ? mountDebrief(root, r.examId, r.classroomId, r.schoolId)
                : r.name === "studyhall"
                  ? mountStudyHall(root, r.schoolId, r.conceptId)
                  : r.name === "progress"
                    ? mountProgress(root)
                    : r.name === "meeting"
                      ? mountMeeting(root, r.classroomId, r.schoolId)
                      : () => {};
  current = { key, root, unmount };
}

function renderToasts(s: AppState) {
  const show = s.route.name !== "classroom";
  toasts.hidden = !show || !s.classroom.toasts.length;
  if (!show) return;
  fill(
    toasts,
    ...s.classroom.toasts.map((t) =>
      h(
        "div",
        { class: `card toast ${t.level}`, role: t.level === "error" ? "alert" : "status" },
        t.text,
        h(
          "button",
          {
            class: "btn small quiet",
            "aria-label": "Dismiss",
            onclick: () =>
              store.setState((st) => ({ classroom: dismissToast(st.classroom, t.id) })),
          },
          "×",
        ),
      ),
    ),
  );
}

export function installScreens(): void {
  stage.append(toasts);
  installCampusSync();
  mount(store.getState().route);
  renderToasts(store.getState());
  store.subscribe((s, p) => {
    if (s.route !== p.route) mount(s.route);
    if (s.classroom.toasts !== p.classroom.toasts || s.route !== p.route) renderToasts(s);
  });
}
