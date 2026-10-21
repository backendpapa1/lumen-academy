import * as THREE from "three";
import type { ClassroomState } from "../../core/classroom";
import { SERVER_HTTP } from "../../core/net";
import { accentOf } from "../../ui/theme";
import { CadetHologram } from "./CadetHologram";

/** Keeps one hologram per enrolled cadet in sync with the classroom state. */
export class CadetLayer {
  readonly group = new THREE.Group();
  private readonly holograms = new Map<string, CadetHologram>();
  private time = 0;
  /** New cadets arrive with the registration effect (set during registration). */
  materializeNew = false;

  sync(c: ClassroomState): void {
    for (const [id, h] of this.holograms) {
      if (!c.cadets[id]) {
        this.group.remove(h.group);
        h.dispose();
        this.holograms.delete(id);
      }
    }
    const raised = new Set(c.hands.map((h) => h.cadetId));
    const speaking = c.speech ? c.speech.cadetId : null;
    for (const cadet of Object.values(c.cadets)) {
      let h = this.holograms.get(cadet.id);
      if (!h) {
        h = new CadetHologram(
          cadet.id,
          cadet.seat,
          accentOf(cadet.archetype),
          hash(cadet.id),
          this.materializeNew,
        );
        this.holograms.set(cadet.id, h);
        this.group.add(h.group);
      }
      h.setState(cadet.state, this.time);
      h.setHandRaised(raised.has(cadet.id) && speaking !== cadet.id);
      h.setSpeaking(speaking === cadet.id);
      h.setPortrait(cadet.portraitUrl ? SERVER_HTTP + cadet.portraitUrl : null);
    }
  }

  update(dt: number, camera: THREE.Camera): void {
    this.time += dt;
    for (const h of this.holograms.values()) h.update(dt, camera);
  }

  highlight(hoveredId: string | null, selectedId: string | null): void {
    for (const [id, h] of this.holograms)
      h.setHighlight(id === selectedId ? 1 : id === hoveredId ? 0.6 : 0);
  }

  /** Cadet whose billboard the ray hits first. */
  pick(ray: THREE.Raycaster): string | null {
    const targets = [...this.holograms.values()].map((h) => h.hitTarget);
    const hit = ray.intersectObjects(targets, false)[0];
    if (!hit) return null;
    for (const [id, h] of this.holograms) if (h.hitTarget === hit.object) return id;
    return null;
  }

  get(id: string): CadetHologram | undefined {
    return this.holograms.get(id);
  }

  dispose(): void {
    for (const h of this.holograms.values()) h.dispose();
    this.holograms.clear();
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
  return h >>> 0;
}
