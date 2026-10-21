import { assetSrc } from "../../core/api";
import { app } from "../../core/app";
import { store, type AppState } from "../../core/store";
import { campusView } from "../../world/anchors";
import type { Campus } from "../campus/Campus";

// Keeps the 3D campus in step with the data: wings and their tiers, streak fog,
// and where the camera looks (the School you're in, or the one you hover).
// A tier-up plays once: the last tier seen per School is remembered locally.

const SEEN_KEY = "lumen.seenTiers";
let synced: { scene: Campus | null; campus: unknown; schools: unknown } = {
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
          accent: school?.accent ?? "#2A40FF",
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
      if (w.tier === 4) {
        // V7-03: reaching Landmark is a festival day on the campus.
        scene.celebrate(schools.find((x) => x.id === id)?.accent ?? "#2A40FF");
        app.notify(`Festival day! ${name} is now a Landmark: library, lab, garden and fountain.`);
      } else app.notify(`${name} grew: its building is now a ${w.tierName}.`);
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
