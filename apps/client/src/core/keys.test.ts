import { describe, expect, it } from "vitest";
import { cycle, routeKey, type KeyContext } from "./keys";

const ctx = (key: string, over: Partial<KeyContext> = {}): KeyContext => ({
  key,
  shift: false,
  focus: null,
  lecternEmpty: true,
  somethingOpen: false,
  paused: false,
  ...over,
});

describe("routeKey", () => {
  it("maps the §3.4 keys when no field has focus", () => {
    expect(routeKey(ctx("Enter"))).toEqual({ do: "focusLectern" });
    expect(routeKey(ctx("Tab"))).toEqual({ do: "cycleHands", dir: 1 });
    expect(routeKey(ctx("Tab", { shift: true }))).toEqual({ do: "cycleHands", dir: -1 });
    expect(routeKey(ctx(" "))).toEqual({ do: "callSelected" });
    expect(routeKey(ctx("3"))).toEqual({ do: "callPosition", index: 2 });
    expect(routeKey(ctx("Escape"))).toEqual({ do: "pause" });
    expect(routeKey(ctx("F"))).toEqual({ do: "hyperfocus" });
    expect(routeKey(ctx("n"))).toEqual({ do: "notes" });
    expect(routeKey(ctx("`"))).toEqual({ do: "transcript" });
    expect(routeKey(ctx("r"))).toEqual({ do: "roster" });
    expect(routeKey(ctx("p"))).toEqual({ do: "park" });
    expect(routeKey({ ...ctx("P"), shift: true })).toEqual({ do: "stats" });
    expect(routeKey(ctx("m"))).toEqual({ do: "mute" });
  });

  it("lets the lectern own typing, but not Tab, Esc, or Space when empty", () => {
    const lectern = (key: string, lecternEmpty = false) =>
      routeKey(ctx(key, { focus: "lectern", lecternEmpty }));
    for (const key of ["3", "f", "n", "r", "`", "Enter", "a"])
      expect(lectern(key)).toEqual({ do: "none" });
    expect(lectern(" ")).toEqual({ do: "none" }); // a space between words
    expect(lectern(" ", true)).toEqual({ do: "callSelected" });
    expect(lectern("Tab")).toEqual({ do: "cycleHands", dir: 1 });
    expect(lectern("Escape")).toEqual({ do: "blur" });
  });

  it("Esc closes an open drawer before it pauses", () => {
    expect(routeKey(ctx("Escape", { somethingOpen: true }))).toEqual({ do: "closeTop" });
  });

  it("while paused only Esc, Space and Enter do anything: they resume", () => {
    const paused = (key: string) => routeKey(ctx(key, { paused: true }));
    for (const key of ["Escape", " ", "Enter"]) expect(paused(key)).toEqual({ do: "resume" });
    for (const key of ["Tab", "1", "f", "r", "`"]) expect(paused(key)).toEqual({ do: "none" });
  });

  it("other fields (transcript search) keep their keys", () => {
    expect(routeKey(ctx("r", { focus: "field" }))).toEqual({ do: "none" });
    expect(routeKey(ctx(" ", { focus: "field" }))).toEqual({ do: "none" });
  });
});

describe("cycle", () => {
  it("wraps both ways and starts at an end", () => {
    const q = ["a", "b", "c"];
    expect(cycle(q, null, 1)).toBe("a");
    expect(cycle(q, null, -1)).toBe("c");
    expect(cycle(q, "c", 1)).toBe("a");
    expect(cycle(q, "a", -1)).toBe("c");
    expect(cycle(q, "gone", 1)).toBe("a");
    expect(cycle([], "a", 1)).toBeNull();
  });
});
