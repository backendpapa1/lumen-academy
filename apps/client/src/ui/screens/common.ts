import { ARCHETYPE_INFO, type Archetype } from "@lumen/shared";
import { assetSrc } from "../../core/api";
import { lookFor, peepSvg, restingFace } from "../peeps/peep";
import { h } from "./dom";

// Pieces shared by the setup screens.

const badges = import.meta.glob<string>("../../assets/generated/badges/*.webp", {
  eager: true,
  import: "default",
});

/** Ranks in order (config/game.yaml); the medal gains a star per step. The Dean is the visitor. */
const RANK_ORDER = [
  "student teacher",
  "teacher",
  "senior teacher",
  "head of department",
  "principal",
  "chancellor",
];

/** A drawn medal for a rank (ADR-009), as an image URL: a ribbon, a disc, and stars by level. */
export function rankInsignia(rank: string): string {
  const key = rank.toLowerCase();
  const dean = key === "dean";
  const level = dean ? 3 : Math.max(0, RANK_ORDER.indexOf(key));
  const stars = Math.min(5, level + 1);
  const star = (x: number, y: number, r: number) => {
    const pts = Array.from({ length: 10 }, (_, i) => {
      const a = (Math.PI / 5) * i - Math.PI / 2;
      const rr = i % 2 ? r * 0.45 : r;
      return `${(x + Math.cos(a) * rr).toFixed(1)},${(y + Math.sin(a) * rr).toFixed(1)}`;
    }).join(" ");
    return `<polygon points="${pts}" fill="#FFC23D" stroke="#2A40FF" stroke-width="2" stroke-linejoin="round"/>`;
  };
  const row = Array.from({ length: stars }, (_, i) =>
    star(50 + (i - (stars - 1) / 2) * 13, 62, stars > 3 ? 6 : 7.5),
  ).join("");
  const ribbon = dean ? "#F0442E" : level >= 4 ? "#FFC23D" : "#2A40FF";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <path d="M30 4 h16 l8 30 h-16z" fill="${ribbon}" stroke="#2A40FF" stroke-width="3" stroke-linejoin="round"/>
    <path d="M70 4 h-16 l-8 30 h16z" fill="#DCE4FF" stroke="#2A40FF" stroke-width="3" stroke-linejoin="round"/>
    <circle cx="54" cy="60" r="32" fill="#2A40FF"/>
    <circle cx="50" cy="56" r="32" fill="${dean ? "#FFF1CC" : "#FFFFFF"}" stroke="#2A40FF" stroke-width="3.5"/>
    <circle cx="50" cy="56" r="24" fill="none" stroke="#2A40FF" stroke-width="2" stroke-dasharray="3 4"/>
    <text x="50" y="50" text-anchor="middle" font-family="Space Mono, monospace" font-weight="700" font-size="13" fill="#2A40FF">${dean ? "DEAN" : `L${level + 1}`}</text>
    ${row}
  </svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function badgeSrc(archetype: Archetype): string | undefined {
  return badges[`../../assets/generated/badges/${archetype}.webp`];
}

/** School emblem with its accent halo; a monogram until the emblem is generated. */
export function emblem(
  s: { name: string; accent: string | null; emblemUrl: string | null },
  large = false,
) {
  const el = h("div", {
    class: `emblem${large ? " large" : ""}`,
    style: `--accent:${s.accent ?? "#2A40FF"}`,
  });
  const src = assetSrc(s.emblemUrl);
  el.append(
    src
      ? h("img", { src, alt: "" })
      : h(
          "span",
          { class: "mono-mark", "aria-hidden": "true" },
          s.name.trim().slice(0, 1).toUpperCase(),
        ),
  );
  return el;
}

/** A student's drawn head and shoulders (ADR-009): the same person as at their desk. */
export function portrait(c: { id: string; archetype: Archetype; name: string }) {
  const el = h("div", {
    class: "portrait",
    role: "img",
    "aria-label": c.name,
    style: `--accent:${ARCHETYPE_INFO[c.archetype].accent}`,
  });
  el.innerHTML = peepSvg(lookFor(c.id), { face: restingFace(c.archetype) });
  return el;
}

export function statusChip(status: string, label?: string) {
  const kind =
    status === "ready" || status === "active" || status === "assembled"
      ? "ok"
      : status === "error"
        ? "err"
        : status === "queued" ||
            status === "parsing" ||
            status === "embedding" ||
            status === "building" ||
            status === "registering" ||
            status === "arriving"
          ? "busy"
          : "";
  return h("span", { class: `chip ${kind}` }, h("span", { class: "dot" }), label ?? status);
}

export const plural = (n: number, word: string, many = `${word}s`) =>
  `${n} ${n === 1 ? word : many}`;
