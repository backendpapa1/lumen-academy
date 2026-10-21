import { BOARD_H, BOARD_W, emptyDiagram, type Diagram } from "@lumen/shared";
import { app } from "../../core/app";
import { store } from "../../core/store";
import { fill, h } from "../screens/dom";
import { classroomUi } from "./index";
import { GRID, nodeAt, recognize, snap, type Point } from "./sketch";

// Drawing on the board (V6-09, VD13): boxes, arrows and labels as objects.
// Box: drag a rectangle (or drag a box to move it). Arrow: drag from one box
// to another. Text: click to place a note. Pen: freehand; a rough box or a
// line between two boxes snaps to the real thing, anything else stays a mark.
// Erase: click something. Double-click a box or arrow to label it. Done sends
// it to the class as a teaching turn.

type Tool = "box" | "arrow" | "text" | "pen" | "erase";
const TOOLS: Array<[Tool, string, string]> = [
  ["box", "Box", "B"],
  ["arrow", "Arrow", "A"],
  ["text", "Text", "T"],
  ["pen", "Pen", "P"],
  ["erase", "Erase", "E"],
];

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;
const clampX = (x: number) => Math.max(0, Math.min(BOARD_W, x));
const clampY = (y: number) => Math.max(0, Math.min(BOARD_H, y));

export class BoardDrawing {
  active = false;
  private work: Diagram = emptyDiagram();
  private tool: Tool = "box";
  private drag:
    | { kind: "box"; from: Point; to: Point }
    | { kind: "move"; id: string; dx: number; dy: number }
    | { kind: "arrow"; from: string; to: Point }
    | { kind: "pen"; points: Point[] }
    | null = null;
  private input: HTMLInputElement | null = null;
  readonly bar = h("div", {
    class: "draw-bar card",
    hidden: true,
    role: "toolbar",
    "aria-label": "Draw on the board",
  });

  constructor(host: HTMLElement) {
    host.append(this.bar);
  }

  private get room() {
    return classroomUi.room;
  }

  toggle() {
    if (this.active) this.finish(true);
    else this.open();
  }

  open() {
    const room = this.room;
    const c = store.getState().classroom;
    if (!room || c.status !== "live") return;
    this.active = true;
    this.work = structuredClone(c.diagram ?? emptyDiagram());
    room.drawing = this.work;
    room.el.classList.add("drawing");
    const svgEl = room.el.querySelector("svg")!;
    svgEl.addEventListener("pointerdown", this.down);
    window.addEventListener("pointermove", this.move);
    window.addEventListener("pointerup", this.up);
    svgEl.addEventListener("dblclick", this.dbl);
    window.addEventListener("keydown", this.key, { capture: true });
    this.renderBar();
    this.draw();
  }

  /** Done (keep and send) or cancel (throw away the edits). */
  finish(keep: boolean) {
    const room = this.room;
    this.commitInput();
    this.active = false;
    this.bar.hidden = true;
    if (room) {
      room.drawing = null;
      room.el.classList.remove("drawing");
      const svgEl = room.el.querySelector("svg")!;
      svgEl.removeEventListener("pointerdown", this.down);
      svgEl.removeEventListener("dblclick", this.dbl);
    }
    window.removeEventListener("pointermove", this.move);
    window.removeEventListener("pointerup", this.up);
    window.removeEventListener("keydown", this.key, { capture: true });
    if (keep) {
      const before = JSON.stringify(store.getState().classroom.diagram ?? emptyDiagram());
      if (JSON.stringify(this.work) !== before) app.saveDiagram(this.work);
    }
    room?.renderDiagram(store.getState().classroom.diagram);
  }

  private renderBar() {
    this.bar.hidden = false;
    fill(
      this.bar,
      ...TOOLS.map(([t, label, k]) =>
        h(
          "button",
          {
            class: `btn small ${this.tool === t ? "primary" : ""}`,
            "aria-pressed": String(this.tool === t),
            title: `${label} (${k})`,
            onclick: () => this.setTool(t),
          },
          label,
        ),
      ),
      h("span", { class: "spacer" }),
      h(
        "button",
        {
          class: "btn small quiet",
          onclick: () => {
            this.work.nodes = [];
            this.work.edges = [];
            this.work.labels = [];
            this.work.strokes = [];
            this.draw();
          },
        },
        "Clear",
      ),
      h("button", { class: "btn small quiet", onclick: () => this.finish(false) }, "Cancel"),
      h(
        "button",
        { class: "btn small primary", onclick: () => this.finish(true) },
        "Done · show the class",
      ),
    );
  }

  private setTool(t: Tool) {
    this.tool = t;
    this.renderBar();
  }

  private draw(preview = "") {
    this.room?.renderDiagram(this.work, { editing: true, preview });
  }

  // --- pointer -------------------------------------------------------------------

  private hitId(e: Event): { kind: string; id: string } | null {
    const el = (e.target as Element | null)?.closest?.("[data-id]");
    if (!el || !el.closest(".diagram")) return null;
    const kind = el.classList.contains("d-node")
      ? "node"
      : el.classList.contains("d-edge")
        ? "edge"
        : el.classList.contains("d-label")
          ? "label"
          : "stroke";
    return { kind, id: el.getAttribute("data-id")! };
  }

  private inBoard(p: Point) {
    return p[0] >= -10 && p[0] <= BOARD_W + 10 && p[1] >= -10 && p[1] <= BOARD_H + 10;
  }

  private down = (e: PointerEvent) => {
    const room = this.room;
    if (!room || e.button !== 0) return;
    const p = room.toBoard(e);
    if (!this.inBoard(p)) return;
    e.preventDefault();
    e.stopPropagation();
    this.commitInput();
    const hit = this.hitId(e);
    if (this.tool === "erase") {
      if (hit) this.erase(hit.kind, hit.id);
      return;
    }
    if (this.tool === "text") {
      const label = { id: uid("l"), x: clampX(snap(p[0])), y: clampY(snap(p[1])), text: "" };
      this.work.labels.push(label);
      this.draw();
      this.edit("label", label.id);
      return;
    }
    if (this.tool === "pen") {
      this.drag = { kind: "pen", points: [p] };
      return;
    }
    const on = nodeAt(this.work.nodes, p, 0);
    if (this.tool === "box") {
      this.drag = on
        ? { kind: "move", id: on.id, dx: p[0] - on.x, dy: p[1] - on.y }
        : { kind: "box", from: p, to: p };
      return;
    }
    // Arrow: from a box (or the nearest one within reach).
    const from = on ?? nodeAt(this.work.nodes, p);
    if (from) this.drag = { kind: "arrow", from: from.id, to: p };
  };

  private move = (e: PointerEvent) => {
    const room = this.room;
    const d = this.drag;
    if (!room || !d) return;
    const p = room.toBoard(e);
    if (d.kind === "pen") {
      const last = d.points.at(-1)!;
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 3 && d.points.length < 400)
        d.points.push([clampX(p[0]), clampY(p[1])]);
      this.draw(
        `<polyline class="d-stroke ghost" points="${d.points.map((q) => q.join(",")).join(" ")}"/>`,
      );
    } else if (d.kind === "box") {
      d.to = p;
      const x = Math.min(d.from[0], p[0]);
      const y = Math.min(d.from[1], p[1]);
      this.draw(
        `<rect class="ghost" x="${snap(x)}" y="${snap(y)}" width="${snap(Math.abs(p[0] - d.from[0]))}" height="${snap(Math.abs(p[1] - d.from[1]))}"/>`,
      );
    } else if (d.kind === "move") {
      const n = this.work.nodes.find((x) => x.id === d.id);
      if (!n) return;
      n.x = clampX(snap(p[0] - d.dx));
      n.y = clampY(snap(p[1] - d.dy));
      this.draw();
    } else {
      d.to = p;
      const n = this.work.nodes.find((x) => x.id === d.from)!;
      this.draw(
        `<line class="ghost" x1="${n.x + n.w / 2}" y1="${n.y + n.h / 2}" x2="${p[0]}" y2="${p[1]}" marker-end="url(#arrowhead)"/>`,
      );
    }
  };

  private up = (e: PointerEvent) => {
    const room = this.room;
    const d = this.drag;
    this.drag = null;
    if (!room || !d) return;
    const p = room.toBoard(e);
    if (d.kind === "box") {
      const w = snap(Math.abs(p[0] - d.from[0]));
      const hgt = snap(Math.abs(p[1] - d.from[1]));
      if (w >= GRID * 4 && hgt >= GRID * 3)
        this.addBox(Math.min(d.from[0], p[0]), Math.min(d.from[1], p[1]), w, hgt);
      else this.draw();
    } else if (d.kind === "arrow") {
      const to = nodeAt(this.work.nodes, p);
      if (to && to.id !== d.from) this.addEdge(d.from, to.id);
      else this.draw();
    } else if (d.kind === "pen") {
      const r = recognize(d.points, this.work.nodes);
      if (r.kind === "box") this.addBox(r.x, r.y, r.w, r.h);
      else if (r.kind === "arrow") this.addEdge(r.from, r.to);
      else if (d.points.length > 1 && this.work.strokes.length < 30) {
        this.work.strokes.push({
          id: uid("s"),
          points: d.points.map(([x, y]) => [Math.round(x), Math.round(y)]),
        });
        this.draw();
      } else this.draw();
    } else this.draw();
  };

  private dbl = (e: MouseEvent) => {
    const hit = this.hitId(e);
    if (hit && (hit.kind === "node" || hit.kind === "edge" || hit.kind === "label"))
      this.edit(hit.kind, hit.id);
  };

  private key = (e: KeyboardEvent) => {
    if (this.input) return; // typing a label
    const k = e.key.toLowerCase();
    const t = TOOLS.find(([, , key]) => key.toLowerCase() === k);
    if (t) this.setTool(t[0]);
    else if (e.key === "Escape") this.finish(false);
    else if (e.key === "Enter") this.finish(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  // --- edits -----------------------------------------------------------------------

  private addBox(x: number, y: number, w: number, hgt: number) {
    if (this.work.nodes.length >= 20)
      return void app.notify("That's a full board: 20 boxes at most.");
    const n = {
      id: uid("n"),
      x: clampX(snap(x)),
      y: clampY(snap(y)),
      w: Math.min(BOARD_W, w),
      h: Math.min(BOARD_H, hgt),
      label: "",
    };
    this.work.nodes.push(n);
    this.draw();
    this.edit("node", n.id);
  }

  private addEdge(from: string, to: string) {
    if (this.work.edges.some((x) => x.from === from && x.to === to)) return void this.draw();
    if (this.work.edges.length >= 30) return;
    this.work.edges.push({ id: uid("e"), from, to, label: "" });
    this.draw();
  }

  private erase(kind: string, id: string) {
    if (kind === "node") {
      this.work.nodes = this.work.nodes.filter((n) => n.id !== id);
      this.work.edges = this.work.edges.filter((x) => x.from !== id && x.to !== id);
    } else if (kind === "edge") this.work.edges = this.work.edges.filter((x) => x.id !== id);
    else if (kind === "label") this.work.labels = this.work.labels.filter((x) => x.id !== id);
    else this.work.strokes = this.work.strokes.filter((x) => x.id !== id);
    this.draw();
  }

  /** An input over the board where the label goes; Enter keeps it, Esc drops it. */
  private edit(kind: string, id: string) {
    const room = this.room;
    if (!room) return;
    this.commitInput();
    const node = kind === "node" ? this.work.nodes.find((n) => n.id === id) : undefined;
    const edge = kind === "edge" ? this.work.edges.find((x) => x.id === id) : undefined;
    const label = kind === "label" ? this.work.labels.find((x) => x.id === id) : undefined;
    if (!node && !edge && !label) return;
    let at: Point;
    if (node) at = [node.x + node.w / 2, node.y + node.h / 2];
    else if (edge) {
      const a = this.work.nodes.find((n) => n.id === edge.from)!;
      const b = this.work.nodes.find((n) => n.id === edge.to)!;
      at = [(a.x + a.w / 2 + b.x + b.w / 2) / 2, (a.y + a.h / 2 + b.y + b.h / 2) / 2];
    } else at = [label!.x, label!.y];
    const s = room.toScreen(at);
    const input = h("input", {
      class: "draw-input",
      maxlength: 60,
      value: node?.label ?? edge?.label ?? label?.text ?? "",
      placeholder: node ? "Label the box" : edge ? "Label the arrow (optional)" : "A note",
      "aria-label": node ? "Box label" : edge ? "Arrow label" : "Note",
      style: `left:${s.x}px;top:${s.y}px`,
    });
    const set = (v: string) => {
      if (node) node.label = v;
      if (edge) edge.label = v;
      if (label) label.text = v;
    };
    input.addEventListener("input", () => set(input.value));
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") this.commitInput();
      if (e.key === "Escape") {
        // A brand-new, empty note goes away; anything else keeps what it had.
        if (label && !label.text.trim())
          this.work.labels = this.work.labels.filter((x) => x.id !== label.id);
        this.commitInput();
      }
    });
    document.querySelector("#stage")!.append(input);
    this.input = input;
    queueMicrotask(() => input.focus());
  }

  private commitInput() {
    if (!this.input) return;
    this.input.remove();
    this.input = null;
    this.work.labels = this.work.labels.filter((l) => l.text.trim());
    this.draw();
  }
}
