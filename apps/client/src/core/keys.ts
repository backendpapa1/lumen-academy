// Keyboard map (docs/02 §3.4) as a pure function so the focus rules are testable.
// While a text field has focus it owns the keys, except Tab (cycle hands),
// Space in an empty lectern (call the selected hand) and Esc.

export interface KeyContext {
  key: string;
  shift: boolean;
  /** "lectern" | "field" (e.g. transcript search) | null */
  focus: "lectern" | "field" | null;
  lecternEmpty: boolean;
  /** Something Esc should close first: concept menu, transcript, roster. */
  somethingOpen: boolean;
  /** While paused only resuming works (Esc, Space or Enter). */
  paused: boolean;
}

export type KeyAction =
  | { do: "none" }
  | { do: "focusLectern" }
  | { do: "blur" }
  | { do: "cycleHands"; dir: 1 | -1 }
  | { do: "callSelected" }
  | { do: "callPosition"; index: number }
  | { do: "closeTop" }
  | { do: "pause" }
  | { do: "resume" }
  | { do: "transcript" }
  | { do: "roster" }
  | { do: "stats" }
  | { do: "mute" }
  | { do: "hyperfocus" }
  | { do: "notes" }
  | { do: "park" };

const NONE: KeyAction = { do: "none" };

export function routeKey(k: KeyContext): KeyAction {
  if (k.paused)
    return !k.focus && ["Escape", " ", "Enter"].includes(k.key) ? { do: "resume" } : NONE;
  if (k.key === "Tab") return { do: "cycleHands", dir: k.shift ? -1 : 1 };
  if (k.key === "Escape")
    return k.focus ? { do: "blur" } : k.somethingOpen ? { do: "closeTop" } : { do: "pause" };
  if (k.focus === "lectern" && k.key === " " && k.lecternEmpty) return { do: "callSelected" };
  if (k.focus) return NONE;
  if (/^[1-9]$/.test(k.key)) return { do: "callPosition", index: Number(k.key) - 1 };
  switch (k.key.toLowerCase()) {
    case "enter":
      return { do: "focusLectern" };
    case " ":
      return { do: "callSelected" };
    case "`":
      return { do: "transcript" };
    case "r":
      return { do: "roster" };
    case "p":
      // V3-04: P parks a stray thought; the stats overlay moved to Shift+P.
      return k.shift ? { do: "stats" } : { do: "park" };
    case "m":
      return { do: "mute" };
    case "f":
      return { do: "hyperfocus" };
    case "n":
      return { do: "notes" };
  }
  return NONE;
}

/** Next hand in the queue after `current` (wraps; starts at the first). */
export function cycle(queue: string[], current: string | null, dir: 1 | -1): string | null {
  if (!queue.length) return null;
  const i = current ? queue.indexOf(current) : -1;
  if (i < 0) return dir === 1 ? queue[0]! : queue.at(-1)!;
  return queue[(i + dir + queue.length) % queue.length]!;
}
