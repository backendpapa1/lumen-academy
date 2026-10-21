import { ARCHETYPE_INFO, type Archetype } from "@lumen/shared";
import { assetSrc } from "../../core/api";
import silhouetteUrl from "../../assets/generated/cadets/silhouette.webp";
import { h } from "./dom";

// Pieces shared by the setup screens.

const badges = import.meta.glob<string>("../../assets/generated/badges/*.webp", {
  eager: true,
  import: "default",
});

const ranks = import.meta.glob<string>("../../assets/generated/ranks/*.webp", {
  eager: true,
  import: "default",
});

/** The generated insignia for a rank name ("Cadet Instructor" → ranks/cadet_instructor.webp). */
export function rankInsignia(rank: string): string | undefined {
  return ranks[`../../assets/generated/ranks/${rank.toLowerCase().replace(/\s+/g, "_")}.webp`];
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
    style: `--accent:${s.accent ?? "#5BE7FF"}`,
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

/** A cadet's portrait, or the generated silhouette until it lands. */
export function portrait(c: { archetype: Archetype; portraitUrl?: string | null; name: string }) {
  const src = assetSrc(c.portraitUrl);
  return h(
    "div",
    { class: "portrait", style: `--accent:${ARCHETYPE_INFO[c.archetype].accent}` },
    src
      ? h("img", { src, alt: `Portrait of ${c.name}` })
      : h("img", { class: "sil", src: silhouetteUrl, alt: "" }),
  );
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

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
