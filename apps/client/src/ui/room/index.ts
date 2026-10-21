import { ClassroomHud } from "./hud";
import { Room } from "./Room";

// The drawn classroom on screen (ADR-009): the room, and the HUD while teaching.

export const classroomUi: { room: Room | null; hud: ClassroomHud | null } = {
  room: null,
  hud: null,
};

const stage = () => document.querySelector<HTMLElement>("#stage")!;

/** Registration shows the room filling up; teaching adds the HUD. */
export function showRoom(mode: "registration" | "teaching"): void {
  if (!classroomUi.room)
    classroomUi.room = new Room(stage(), { arrivals: mode === "registration" });
  if (mode === "teaching" && !classroomUi.hud) classroomUi.hud = new ClassroomHud(stage());
  if (mode === "registration" && classroomUi.hud) {
    classroomUi.hud.dispose();
    classroomUi.hud = null;
  }
}

export function hideRoom(): void {
  classroomUi.hud?.dispose();
  classroomUi.room?.dispose();
  classroomUi.hud = null;
  classroomUi.room = null;
}
