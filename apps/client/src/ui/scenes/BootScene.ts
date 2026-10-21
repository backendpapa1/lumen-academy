import * as Phaser from "phaser";
import { app } from "../../core/app";
import { getJson } from "../../core/net";
import { Panel } from "../components/Panel";
import { label } from "../components/text";
import { css, motion, uiScale } from "../theme";

interface SchoolRow {
  id: string;
  name: string;
  classrooms: Array<{
    id: string;
    name: string;
    status: string;
    cadets: number;
    lastPeriodAt: string | null;
  }>;
}

/** Pick a class to teach (M2). One-click "Resume" on boot comes in M5. */
export class BootScene extends Phaser.Scene {
  constructor() {
    super("boot");
  }

  async create(): Promise<void> {
    const { width, height } = this.scale.gameSize;
    const s = uiScale(width, height);
    label(this, width / 2, height * 0.16, "Lumen Academy", "micro", { scale: s }).setOrigin(0.5);
    label(this, width / 2, height * 0.16 + 22 * s, "Choose a class to teach", "h1", {
      scale: s,
    }).setOrigin(0.5);
    let schools: SchoolRow[];
    try {
      schools = await getJson<SchoolRow[]>("/api/schools");
    } catch {
      if (!this.sys.isActive()) return;
      label(
        this,
        width / 2,
        height * 0.4,
        "Can't reach the server. Start it with: pnpm dev",
        "body",
        { scale: s, color: css.aurum },
      ).setOrigin(0.5);
      return;
    }
    // The route may have changed while we were fetching.
    if (!this.sys.isActive()) return;
    const rooms = schools.flatMap((sc) =>
      sc.classrooms.filter((c) => c.status === "active").map((c) => ({ ...c, school: sc.name })),
    );
    if (!rooms.length) {
      label(
        this,
        width / 2,
        height * 0.4,
        "No classes yet. Create one with pnpm cli:ingest, cli:curriculum and cli:register.",
        "body",
        { scale: s, color: css.inkDim, wrap: 640 * s },
      ).setOrigin(0.5);
      return;
    }
    // Most recently taught first, so the class you were in is the first card.
    rooms.sort((a, b) => (b.lastPeriodAt ?? "").localeCompare(a.lastPeriodAt ?? ""));
    const w = 520 * s;
    const h = 78 * s;
    rooms.slice(0, 6).forEach((r, i) => {
      const y = height * 0.28 + i * (h + 14 * s);
      const card = new Panel(this, (width - w) / 2, y, w, h);
      card.add(label(this, 20 * s, 16 * s, r.school, "micro", { scale: s }));
      card.add(label(this, 20 * s, 34 * s, r.name, "h2", { scale: s }));
      card.add(
        label(
          this,
          w - 20 * s,
          36 * s,
          `${r.cadets} cadets${i === 0 && r.lastPeriodAt ? " · last taught" : ""}`,
          "caption",
          { scale: s },
        ).setOrigin(1, 0),
      );
      card.setInteractive({
        hitArea: new Phaser.Geom.Rectangle(0, 0, w, h),
        hitAreaCallback: Phaser.Geom.Rectangle.Contains,
        useHandCursor: true,
      });
      card
        .on("pointerover", () => card.setFocused(true))
        .on("pointerout", () => card.setFocused(false));
      card.on("pointerdown", () => app.startClass(r.id));
      card.setAlpha(0);
      this.tweens.add({ targets: card, alpha: 1, duration: motion.panel, delay: i * 50 });
    });
  }
}
