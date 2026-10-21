import { fadingTarget } from "../game/fading.js";
import type { FastifyInstance } from "fastify";
import type { GameConfig } from "@lumen/shared";
import type { AssetService } from "../assets/service.js";
import type { DbHandle } from "../db/client.js";
import {
  refreshTiers,
  resumeTarget,
  schoolDecalUrl,
  schoolTier,
  streak,
  TIER_NAMES,
} from "../game/campus.js";
import { standing } from "../game/xp.js";

// The campus at a glance (M5): every School with its wing's tier, the
// forgiving streak, rank, and where to resume.

export function registerCampusRoutes(
  app: FastifyInstance,
  deps: { handle: DbHandle; game: GameConfig; assets?: AssetService },
) {
  app.get("/api/campus", async () => {
    refreshTiers(deps.handle, deps.game, deps.assets);
    const schools = deps.handle.sqlite
      .prepare(
        "SELECT id, campus_slot AS slot FROM schools WHERE archived = 0 ORDER BY campus_slot",
      )
      .all() as Array<{
      id: string;
      slot: number;
    }>;
    return {
      wings: schools.map((s) => {
        const t = schoolTier(deps.handle, deps.game, s.id);
        return {
          schoolId: s.id,
          slot: s.slot,
          ...t,
          tierName: TIER_NAMES[t.tier],
          decalUrl: schoolDecalUrl(deps.handle, s.id),
        };
      }),
      streak: streak(deps.handle, deps.game),
      xp: standing(deps.handle, deps.game),
      resume: resumeTarget(deps.handle),
      fading: fadingTarget(deps.handle, deps.game),
    };
  });
}
