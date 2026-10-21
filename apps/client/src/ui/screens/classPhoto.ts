import { api, ApiError } from "../../core/api";
import { app } from "../../core/app";
import { lookFor, peepSvg, rememberHair, restingFace } from "../peeps/peep";
import { fill, h } from "./dom";
import { openModal } from "./modal";

// Class photo (V7-02): when a class graduates, everyone in rows in caps and
// gowns, holding the stickers they gave me (V4), under a banner in the
// School's accent. Drawn here (no image model), saved as SVG with the class
// and linked from the yearbook.

interface PhotoData {
  className: string;
  school: string;
  accent: string | null;
  graduated: boolean;
  saved: boolean;
  date: string;
  students: Array<{
    id: string;
    name: string;
    archetype: string;
    hair: string;
    stickers: string[];
  }>;
}

const W = 1200;
const H = 780;
const GLYPH: Record<string, string> = {
  best_analogy: "💡",
  fixed_confusion: "✓",
  brave_correction: "★",
  landed: "🎯",
  challenge: "🏅",
};
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The photo as standalone SVG (fonts fall back gracefully outside the app). */
export function photoSvg(d: PhotoData): string {
  const accent = d.accent && /^#[0-9a-f]{6}$/i.test(d.accent) ? d.accent : "#2A40FF";
  const n = d.students.length;
  // Back rows hold more; the front row is the closest and biggest.
  const perRow = n <= 5 ? n : n <= 10 ? Math.ceil(n / 2) : Math.ceil(n / 3);
  const rows: (typeof d.students)[] = [];
  for (let i = 0; i < n; i += perRow) rows.push(d.students.slice(i, i + perRow));
  rows.reverse(); // the first students sit in front
  const parts: string[] = [];
  rows.forEach((row, ri) => {
    const depth = rows.length - 1 - ri; // 0 = front
    const scale = 1 - depth * 0.12;
    const bw = 150 * scale;
    const bh = bw * 1.2;
    // Each row stands a head higher than the one in front, so every face shows.
    const y = 652 - depth * 160 - bh;
    const gap = Math.min(bw * 1.08, (W - 120) / Math.max(1, row.length));
    // Alternate rows shift by half a place, so faces show between shoulders.
    const x0 = W / 2 - ((row.length - 1) * gap) / 2 + (depth % 2 ? gap / 2 : 0);
    row.forEach((s, i) => {
      const cx = x0 + i * gap;
      const bust = peepSvg(lookFor(s.id, s.hair), {
        face: s.stickers.length ? "Smile" : restingFace(s.archetype as never),
      }).replace("<svg ", `<svg x="${cx - bw / 2}" y="${y}" width="${bw}" height="${bh}" `);
      // A graduation stole in the School's colour, and a mortarboard on top.
      const sy = y + bh * 0.66;
      const gown = `<path d="M${cx - bw * 0.16} ${sy} L ${cx - bw * 0.05} ${sy + bh * 0.06} L ${cx - bw * 0.12} ${y + bh} L ${cx - bw * 0.25} ${y + bh} z M${cx + bw * 0.16} ${sy} L ${cx + bw * 0.05} ${sy + bh * 0.06} L ${cx + bw * 0.12} ${y + bh} L ${cx + bw * 0.25} ${y + bh} z" fill="${accent}" stroke="#0F1A66" stroke-width="1.5"/>`;
      const capY = y + bh * 0.04;
      const cap = `<g><path d="M${cx - bw * 0.3} ${capY} L ${cx} ${capY - bw * 0.1} L ${cx + bw * 0.3} ${capY} L ${cx} ${capY + bw * 0.1} z" fill="#0F1A66" stroke="#2A40FF" stroke-width="2"/><rect x="${cx - bw * 0.14}" y="${capY + bw * 0.04}" width="${bw * 0.28}" height="${bw * 0.08}" fill="#0F1A66"/><path d="M${cx} ${capY} L ${cx + bw * 0.26} ${capY + bw * 0.05} L ${cx + bw * 0.26} ${capY + bw * 0.2}" stroke="#FFC23D" stroke-width="3" fill="none"/><circle cx="${cx + bw * 0.26}" cy="${capY + bw * 0.22}" r="${bw * 0.025}" fill="#FFC23D"/></g>`;
      const stickers = s.stickers
        .slice(0, 3)
        .map(
          (k, j) =>
            `<g transform="translate(${cx - bw * 0.18 + j * bw * 0.18} ${y + bh * 0.86})"><circle r="${bw * 0.07}" fill="#FFC23D" stroke="#0F1A66" stroke-width="2"/><text y="${bw * 0.03}" text-anchor="middle" font-size="${bw * 0.08}">${GLYPH[k] ?? "★"}</text></g>`,
        )
        .join("");
      // Only the front row's names fit under them; the caption lists everyone.
      const name = depth
        ? ""
        : `<text x="${cx}" y="${y + bh + 18}" text-anchor="middle" font-family="Space Mono, monospace" font-weight="700" font-size="14" fill="#0F1A66">${esc(s.name.split(" ")[0]!)}</text>`;
      parts.push(bust, gown, cap, stickers, name);
    });
  });
  const when = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(d.date));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#C6ECFF"/><stop offset="1" stop-color="#FAFBFF"/></linearGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#sky)"/>
  <rect x="0" y="${H - 120}" width="${W}" height="120" fill="#DCE4FF"/>
  <g>${Array.from({ length: 22 }, (_, i) => `<path d="M${i * 56} 18 l28 0 l-14 26 z" fill="${i % 2 ? accent : "#FFC23D"}" stroke="#0F1A66" stroke-width="1.5"/>`).join("")}<path d="M0 18 H ${W}" stroke="#0F1A66" stroke-width="2"/></g>
  <rect x="${W / 2 - 330}" y="60" width="660" height="76" fill="${accent}" stroke="#0F1A66" stroke-width="3"/>
  <rect x="${W / 2 - 322}" y="68" width="660" height="76" fill="none" stroke="#0F1A66" stroke-width="3"/>
  <text x="${W / 2}" y="108" text-anchor="middle" font-family="Bungee, Impact, sans-serif" font-size="34" fill="#FFFFFF">${esc(d.className)} · ${esc(d.school)}</text>
  <text x="${W / 2}" y="132" text-anchor="middle" font-family="Space Mono, monospace" font-size="15" fill="#FFFFFF">Graduated ${esc(when)} · Lumen Academy</text>
  ${parts.join("")}
  ${[...rows]
    .reverse()
    .map((row, i, all) => {
      const label =
        all.length === 1 ? "" : i === 0 ? "Front: " : i === all.length - 1 ? "Back: " : "Middle: ";
      return `<text x="${W / 2}" y="${H - 44 + i * 16 - (all.length - 1) * 8}" text-anchor="middle" font-family="Space Mono, monospace" font-size="12" fill="#4A5699">${esc(label + row.map((r) => r.name).join(", "))}</text>`;
    })
    .join("")}
</svg>`;
}

export function openClassPhoto(classroomId: string) {
  const body = h(
    "div",
    { class: "photo" },
    h("p", { class: "dim" }, "Gathering everyone for the photo…"),
  );
  openModal("Class photo", body);
  api
    .get<PhotoData>(`/api/classrooms/${classroomId}/photo-data`)
    .then((d) => {
      rememberHair(d.students.map((s) => [s.id, s.hair]));
      const svg = photoSvg(d);
      const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      const save = h(
        "button",
        {
          class: "btn primary",
          onclick: () => {
            save.disabled = true;
            api
              .put(`/api/classrooms/${classroomId}/photo`, { svg })
              .then(() => {
                save.textContent = "Saved to the yearbook";
                app.notify("Class photo saved to the yearbook.");
              })
              .catch((e: unknown) => {
                save.disabled = false;
                app.notify(e instanceof ApiError ? e.message : String(e), "error");
              });
          },
        },
        d.saved ? "Save again" : "Keep it for the yearbook",
      );
      fill(
        body,
        h("img", { class: "photo-img", src: url, alt: `${d.className}'s class photo` }),
        h(
          "div",
          { class: "actions" },
          h(
            "a",
            { class: "btn quiet", href: url, download: `${d.className} class photo.svg` },
            "Download",
          ),
          h("span", { class: "spacer" }),
          save,
        ),
      );
    })
    .catch((e: Error) => fill(body, h("p", { class: "error-text" }, e.message)));
}
