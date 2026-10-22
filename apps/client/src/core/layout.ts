// Part B: which layout the screen is in, on <html data-layout>, so CSS and the
// drawn scenes agree. "portrait": a phone held upright (narrow); "landscape":
// a phone on its side (short); "regular": tablets and desktops. And
// data-pointer="coarse" on touch screens, where keyboard hints make no sense.

export type Layout = "portrait" | "landscape" | "regular";

const PORTRAIT = "(max-width: 640px) and (orientation: portrait)";
const LANDSCAPE = "(max-height: 500px) and (orientation: landscape)";

const listeners = new Set<(l: Layout) => void>();

export function currentLayout(): Layout {
  if (matchMedia(PORTRAIT).matches) return "portrait";
  if (matchMedia(LANDSCAPE).matches) return "landscape";
  return "regular";
}

/** Called with the new layout whenever it changes (rotation, a resized window). */
export function onLayout(fn: (l: Layout) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function installLayout(): void {
  const html = document.documentElement;
  let last: Layout | null = null;
  const apply = () => {
    const l = currentLayout();
    html.dataset.pointer = matchMedia("(pointer: coarse)").matches ? "coarse" : "fine";
    if (l === last) return;
    last = l;
    html.dataset.layout = l;
    for (const fn of listeners) fn(l);
  };
  for (const q of [PORTRAIT, LANDSCAPE, "(pointer: coarse)"])
    matchMedia(q).addEventListener("change", apply);
  apply();
}
