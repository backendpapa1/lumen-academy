import type { UpgradeItem } from "@lumen/shared";

// Room upgrades (V7-01), drawn in the room's line style on fixed spots. Each
// returns SVG markup in room units (1600 × 1000). User text is escaped by the
// caller; the only text here is the poster's term and the School's initial.

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function upgradeArt(
  item: UpgradeItem,
  ctx: { emblemUrl: string | null; term: string | null; school: string },
): string {
  switch (item) {
    case "plant":
      // A tall fern between the corkboard and the door.
      return `<g class="u-plant" transform="translate(1334 404)">
        <path class="leaf" d="M24 52 C -8 30 -14 -10 4 -40 C 12 -4 24 14 24 52z"/>
        <path class="leaf" d="M24 52 C 56 30 64 -12 46 -46 C 38 -10 24 16 24 52z"/>
        <path class="leaf" d="M24 52 C 14 8 18 -40 30 -64 C 40 -30 34 12 24 52z"/>
        <path class="pot" d="M4 52 h40 l-5 42 h-30z"/></g>`;
    case "poster": {
      // Between the window and the board: the emblem and a word from the wall.
      const word = ctx.term
        ? esc(ctx.term.length > 14 ? `${ctx.term.slice(0, 13)}…` : ctx.term)
        : esc(ctx.school.slice(0, 14));
      return `<g class="u-poster" transform="translate(370 96)">
        <rect class="poster-shadow" x="4" y="4" width="64" height="150"/>
        <rect class="poster" width="64" height="150"/>
        ${
          ctx.emblemUrl
            ? `<image href="${esc(ctx.emblemUrl)}" x="6" y="8" width="52" height="52" preserveAspectRatio="xMidYMid meet"/>`
            : `<circle class="poster-mark" cx="32" cy="34" r="22"/><text class="poster-initial" x="32" y="42" text-anchor="middle">${esc(ctx.school.slice(0, 1).toUpperCase())}</text>`
        }
        <text class="poster-term" transform="translate(32 140) rotate(-90)">${word}</text>
        <circle class="pin" cx="32" cy="4" r="3"/></g>`;
    }
    case "goldfish":
      return `<g class="u-goldfish" transform="translate(110 374)">
        <path class="bowl" d="M-22 -18 C -40 4 -30 28 0 28 C 30 28 40 4 22 -18 z"/>
        <path class="water" d="M-28 -2 C -26 20 -14 26 0 26 C 14 26 26 20 28 -2 z"/>
        <g class="fish"><path d="M-6 6 C 0 -2 10 -2 14 6 C 10 14 0 14 -6 6 z"/><path d="M-6 6 l-8 -6 v12 z"/></g>
        <circle class="bubble-dot" cx="10" cy="-6" r="2"/><circle class="bubble-dot" cx="6" cy="-12" r="1.5"/></g>`;
    case "cat":
      // Curled up asleep on the second window's sill.
      return `<g class="u-cat" transform="translate(276 380)">
        <path class="cat-body" d="M-40 22 C -44 -4 -18 -16 6 -12 C 30 -8 42 6 40 22 z"/>
        <path class="cat-head" d="M20 -10 l4 -14 l8 10 l8 -10 l4 14 C 50 0 46 14 34 16 C 22 18 16 6 20 -10 z"/>
        <path class="cat-tail" d="M-40 20 C -54 14 -54 0 -44 -2"/>
        <path class="cat-eye" d="M28 2 q3 2 6 0 M38 2 q3 2 6 0"/></g>`;
    case "reading_corner":
      return `<g class="u-reading" transform="translate(24 868)">
        <rect class="shelf" x="0" y="0" width="76" height="110"/>
        <line class="shelf-line" x1="0" y1="52" x2="76" y2="52"/>
        <rect class="book b1" x="6" y="12" width="12" height="40"/><rect class="book b2" x="20" y="18" width="10" height="34"/>
        <rect class="book b3" x="32" y="10" width="14" height="42"/><rect class="book b1" x="10" y="62" width="14" height="44"/>
        <rect class="book b3" x="28" y="66" width="10" height="40"/>
        <path class="beanbag" d="M92 110 C 84 64 120 40 152 52 C 184 64 186 100 176 110 z"/></g>`;
    case "string_lights": {
      const bulbs = Array.from({ length: 14 }, (_, i) => {
        const x = 30 + i * 82;
        const y = 22 + Math.sin((i / 13) * Math.PI * 3) * 6 + 10;
        return `<circle class="bulb b${i % 3}" cx="${x}" cy="${y + 6}" r="6"/>`;
      }).join("");
      return `<g class="u-lights"><path class="wire" d="M10 24 Q 300 60 600 30 T 1200 30"/>${bulbs}</g>`;
    }
    case "globe":
      return `<g class="u-globe" transform="translate(1290 832)">
        <path class="stand" d="M-18 46 h36 M0 46 v-8"/>
        <path class="arc" d="M-28 4 A 30 30 0 0 0 26 22"/>
        <circle class="earth" cx="0" cy="8" r="24"/>
        <path class="land" d="M-12 -4 c6 -6 14 0 10 6 c-4 6 6 10 2 16 c-6 4 -14 -2 -12 -8 z M6 12 c6 -2 10 4 6 8 c-4 2 -8 -2 -6 -8 z"/></g>`;
    case "rug":
      return `<g class="u-rug"><path class="rug" d="M300 1000 L 420 700 L 1180 700 L 1300 1000 z"/>
        <path class="rug-stripe" d="M330 925 L 1270 925 M 360 850 L 1240 850 M 390 775 L 1210 775"/></g>`;
  }
}
