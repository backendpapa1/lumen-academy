import type { Layout } from "../../core/layout";

// How a drawn scene (the classroom, the exam hall) is framed in its window.
// The scenes are drawn 1600 × 1000, with walls and floor running on past both
// sides. A window wider than that sees more of the room sideways, never less
// of the board and desks; a narrower one is cropped at the sides as before. A
// phone held upright frames the board and desks and fits them to the width.

const W = 1600;

export function frameFor(
  layout: Layout,
  width: number,
  height: number,
): { box: string; fit: string } {
  if (layout === "portrait") return { box: "200 40 1180 960", fit: "xMidYMin meet" };
  // A phone on its side trims the ceiling and the very front.
  const [top, tall] = layout === "landscape" ? [20, 780] : [0, 1000];
  const aspect = width > 0 && height > 0 ? width / height : W / tall;
  if (aspect <= W / tall) return { box: `0 ${top} ${W} ${tall}`, fit: "xMidYMin slice" };
  const wide = tall * aspect;
  return {
    box: `${((W - wide) / 2).toFixed(1)} ${top} ${wide.toFixed(1)} ${tall}`,
    fit: "xMidYMid meet",
  };
}
