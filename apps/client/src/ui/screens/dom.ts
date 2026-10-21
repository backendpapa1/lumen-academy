// A tiny element builder for the DOM screens. Text always goes in as text
// nodes (never innerHTML), so nothing from the server or the user is parsed.

type Child = Node | string | number | false | null | undefined;
type Attrs = Record<string, string | number | boolean | EventListener | undefined> & {
  class?: string;
  style?: string;
};

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Replace an element's children. */
export function fill(el: Element, ...children: Child[]) {
  el.replaceChildren();
  append(el, children);
}

/** An inline SVG icon from a path list (Lucide-style, 24px grid, 1.75 stroke). */
export function icon(paths: string[], label?: string): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "icon");
  if (label) svg.setAttribute("aria-label", label);
  else svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

export const ICONS = {
  back: ["M15 18l-6-6 6-6"],
  plus: ["M12 5v14", "M5 12h14"],
  upload: ["M12 16V4", "M7 9l5-5 5 5", "M5 20h14"],
  file: ["M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z", "M14 3v5h5"],
  settings: [
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  ],
  up: ["M18 15l-6-6-6 6"],
  down: ["M6 9l6 6 6-6"],
  trash: ["M3 6h18", "M8 6V4h8v2", "M19 6l-1 14H6L5 6"],
  merge: ["M8 6l4 4 4-4", "M12 10v10", "M6 3h12"],
  sparkle: ["M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"],
  close: ["M18 6L6 18", "M6 6l12 12"],
  play: ["M7 4l13 8-13 8z"],
  mic: ["M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z", "M5 11a7 7 0 0 0 14 0", "M12 18v3"],
  archive: ["M3 4h18v4H3z", "M5 8v12h14V8", "M10 12h4"],
  pencil: ["M4 20l4-1 11-11-3-3L5 16z", "M14 6l3 3"],
  book: ["M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z", "M4 19V5", "M8 7h7"],
  restore: ["M3 12a9 9 0 1 0 3-6.7", "M3 4v5h5"],
  speaker: ["M11 5L6 9H3v6h3l5 4z", "M15.5 8.5a5 5 0 0 1 0 7", "M18.5 5.5a9 9 0 0 1 0 13"],
  mute: ["M11 5L6 9H3v6h3l5 4z", "M22 9l-6 6", "M16 9l6 6"],
  help: [
    "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z",
    "M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3",
    "M12 17h.01",
  ],
};
