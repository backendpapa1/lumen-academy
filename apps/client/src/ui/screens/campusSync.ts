import { assetSrc } from "../../core/api";
import { app } from "../../core/app";
import { store, type AppState } from "../../core/store";
import { campusView } from "../../world/anchors";
import type { CampusScene } from "../../world/scenes/CampusScene";

// Keeps the 3D campus in step with the data: wings and their tiers, streak fog,
// and where the camera looks (the School you're in, or the one you hover).
// A tier-up plays once: the last tier seen per School is remembered locally.

const SEEN_KEY = "lumen.seenTiers";
let synced: { scene: CampusScene | null; campus: unknown; schools: unknown } = {
  scene: null,
  campus: null,
  schools: null,
};
let hovered: string | null = null;

function seenTiers(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}
function saveSeen(v: Record<string, number>) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(v));
  } catch {
    /* tier-ups will just replay */
  }
}

function sync(s: AppState) {
  const scene = campusView.current;
  if (!scene) return;
  const { campus, schools } = s.setup;
  if (
    campus &&
    schools &&
    (scene !== synced.scene || campus !== synced.campus || schools !== synced.schools)
  ) {
    const fresh = scene !== synced.scene;
    synced = { scene, campus, schools };
    const seen = seenTiers();
    const up = scene.setWings(
      campus.wings.map((w) => {
        const school = schools.find((x) => x.id === w.schoolId);
        return {
          ...w,
          accent: school?.accent ?? "#5BE7FF",
          emblemUrl: assetSrc(school?.emblemUrl),
          decalUrl: assetSrc(w.decalUrl),
        };
      }),
      seen,
    );
    scene.setFog(campus.streak.missedDays);
    for (const w of campus.wings) seen[w.schoolId] = w.tier;
    saveSeen(seen);
    if (up.length) {
      const id = up[0]!;
      const w = campus.wings.find((x) => x.schoolId === id)!;
      const name = schools.find((x) => x.id === id)?.name ?? "A School";
      scene.flyTo(id);
      app.notify(`${name} grew: its wing is now a ${w.tierName}.`);
      setTimeout(() => look(store.getState()), 4500);
      return;
    }
    if (fresh) look(s);
  }
}

function look(s: AppState) {
  const scene = campusView.current;
  if (!scene) return;
  const r = s.route;
  const target =
    r.name === "school" || r.name === "desk" || r.name === "debrief" ? r.schoolId : hovered;
  scene.flyTo(target);
}

/** The lobby calls this as the pointer moves over School cards. */
export function hoverSchool(id: string | null) {
  hovered = id;
  look(store.getState());
}

export function installCampusSync() {
  store.subscribe((s, p) => {
    sync(s);
    if (s.route !== p.route) {
      hovered = null;
      look(s);
      if ((s.route.name === "school" || s.route.name === "desk") && !s.setup.campus)
        void app.loadSchools().catch(() => undefined);
    }
  });
  sync(store.getState());
}
