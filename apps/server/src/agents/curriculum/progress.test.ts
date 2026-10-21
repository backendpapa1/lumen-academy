import { describe, expect, it } from "vitest";
import type { CurriculumBuild } from "@lumen/shared";
import { BuildTracker, explainBuildError } from "./progress.js";

const BOOKS = [
  { id: "src_a", title: "Volume I — Ethereum", chapters: 2 },
  { id: "src_b", title: "Volume II — Solidity", chapters: 2 },
];

describe("curriculum build progress (Paul's ask)", () => {
  it("follows the build: chapter by chapter, book by book, with a heartbeat", () => {
    const seen: CurriculumBuild[] = [];
    const t = new BuildTracker("sch_x", BOOKS, (s) => seen.push(structuredClone(s)));
    expect(t.state).toMatchObject({ stage: "preparing", fraction: 0.02, calls: 0 });

    t.handleChatModelStart({} as never, [], "run1");
    expect(t.state.waitingSince).not.toBeNull();
    t.handleLLMEnd({} as never, "run1");
    expect(t.state).toMatchObject({ calls: 1, waitingSince: null });

    t.startBook("src_a");
    expect(t.state.label).toBe("Reading “Volume I — Ethereum”: chapter 1 of 2 · book 1 of 2");
    expect(t.state.sources.map((s) => s.state)).toEqual(["reading", "waiting"]);
    t.chapterDone("src_a");
    expect(t.state.label).toBe("Reading “Volume I — Ethereum”: chapter 2 of 2 · book 1 of 2");
    t.chapterDone("src_a");
    t.bookDone("src_a", "Saved “Volume I — Ethereum”: 2 modules, 9 concepts");
    expect(t.state).toMatchObject({
      stage: "saving",
      label: "Saved “Volume I — Ethereum”: 2 modules, 9 concepts",
    });
    expect(t.state.sources.map((s) => s.state)).toEqual(["done", "waiting"]);
    expect(t.state.fraction).toBeCloseTo(0.03 + 0.88 * 0.5, 5);

    t.startBook("src_b");
    t.chapterDone("src_b");
    t.chapterDone("src_b");
    t.bookDone("src_b", "Saved");
    t.stage("ordering", "Connecting the books", 0.93);
    expect(t.state).toMatchObject({ stage: "ordering", fraction: 0.93 });

    // The fraction never goes backwards.
    const fractions = seen.map((s) => s.fraction);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
  });

  it("says what went wrong, and what to do", () => {
    expect(explainBuildError(new Error("401 Unauthorized"))).toMatch(/refused the API key/);
    expect(explainBuildError(new Error("TypeError: fetch failed"))).toMatch(/internet connection/);
    expect(explainBuildError(new Error("Recursion limit of 150 reached"))).toMatch(/more steps/);
    expect(
      explainBuildError(new Error("Monthly budget reached ($20.00 of $20.00); agents paused")),
    ).toBe(
      "Stopped at your monthly budget cap ($20.00 of $20.00). Raise it in Settings, then press Rebuild.",
    );
    expect(
      explainBuildError(
        new Error('curriculum invalid after re-ask: concept "X" has no valid chunk citation; y'),
      ),
    ).toBe(
      'The draft curriculum still had a problem after one fix (concept "X" has no valid chunk citation). Press Rebuild to try again.',
    );
    expect(explainBuildError(new Error("weird"))).toBe(
      "The build stopped: weird. Press Rebuild to try again.",
    );
  });
});
