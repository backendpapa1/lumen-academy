import * as Phaser from "phaser";
import { css, font, size } from "../theme";

type Role = "display" | "h1" | "h2" | "body" | "caption" | "micro" | "mono" | "monoSmall";

const ROLES: Record<
  Role,
  { family: string; px: number; weight: string; color: string; caps?: boolean }
> = {
  display: { family: font.display, px: size.display, weight: "700", color: css.ink },
  h1: { family: font.display, px: size.h1, weight: "700", color: css.ink },
  h2: { family: font.display, px: size.h2, weight: "500", color: css.ink },
  body: { family: font.body, px: size.body, weight: "400", color: css.ink },
  caption: { family: font.body, px: size.caption, weight: "500", color: css.inkDim },
  micro: { family: font.display, px: size.micro, weight: "500", color: css.inkDim, caps: true },
  mono: { family: font.mono, px: size.body, weight: "600", color: css.ink },
  monoSmall: { family: font.mono, px: size.caption, weight: "400", color: css.inkDim },
};

/** Text in one of the art-direction roles; micro labels are caps with +8% tracking. */
export function label(
  scene: Phaser.Scene,
  x: number,
  y: number,
  text: string,
  role: Role,
  opts: { color?: string; wrap?: number; scale?: number } = {},
) {
  const r = ROLES[role];
  const px = Math.round(r.px * (opts.scale ?? 1));
  const t = scene.add.text(x, y, r.caps ? text.toUpperCase() : text, {
    fontFamily: r.family,
    fontSize: `${px}px`,
    fontStyle: r.weight,
    color: opts.color ?? r.color,
    ...(opts.wrap ? { wordWrap: { width: opts.wrap, useAdvancedWrap: true } } : {}),
    lineSpacing: role === "body" ? Math.round(px * 0.45) : 0,
  });
  if (r.caps) t.setLetterSpacing(px * 0.08);
  return t;
}
