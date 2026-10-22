// The board's writing as plain HTML over the drawn board, placed with the
// SVG's own transform. (It used to be a foreignObject inside the SVG, which
// WebKitGTK, the desktop app's engine, paints at the wrong size and place
// once the room is scaled: the text slid off the board on wide screens.)

export interface BoardLayer {
  /** The text box (class "board-text"), in board units: CSS sizes it. */
  readonly text: HTMLElement;
  /** Follow the board: call when the room may have moved or resized (cheap). */
  place(): void;
}

export function boardLayer(
  host: HTMLElement,
  svg: SVGSVGElement,
  box: { x: number; y: number; width: number; height: number },
  className = "",
): BoardLayer {
  const layer = document.createElement("div");
  layer.className = "board-layer";
  layer.style.width = `${box.width}px`;
  layer.style.height = `${box.height}px`;
  const text = document.createElement("div");
  text.className = `board-text ${className}`.trim();
  layer.append(text);
  host.append(layer);
  let last = "";
  return {
    text,
    place() {
      const m = svg.getScreenCTM();
      if (!m) return;
      const r = host.getBoundingClientRect();
      const p = new DOMPoint(box.x, box.y).matrixTransform(m);
      const t = `translate(${(p.x - r.left).toFixed(1)}px, ${(p.y - r.top).toFixed(1)}px) scale(${m.a.toFixed(4)})`;
      if (t !== last) layer.style.transform = last = t;
    },
  };
}
