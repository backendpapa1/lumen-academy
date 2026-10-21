import { describe, expect, it } from "vitest";
import type { CurriculumBuild } from "@lumen/shared";
import { BuildTracker, explainBuildError } from "./progress.js";

const SOURCES = [
  { id: "src_a", title: "Volume I — Ethereum" },
  { id: "src_b", title: "Volume II — Solidity" },
];

describe("curriculum build progress (Paul's ask)", () => {
  it("follows the agent: reading each source, ordering, checking", () => {
    const seen: CurriculumBuild[] = [];
    const t = new BuildTracker("sch_x", SOURCES, (s) => seen.push(structuredClone(s)));
    expect(t.state).toMatchObject({ stage: "preparing", fraction: 0.02, calls: 0 });

    t.handleChatModelStart({}, [], "run1");
    expect(t.state.waitingSince).not.toBeNull();
    t.handleLLMEnd({}, "run1");
    expect(t.state).toMatchObject({ calls: 1, waitingSince: null });

    t.handleToolStart(
      {},
      JSON.stringify({ description: "Read source src_a", subagent_type: "source-analyst" }),
      "t1",
      undefined,
      [],
      {},
      "task",
    );
    expect(t.state.stage).toBe("reading");
    expect(t.state.label).toBe("Reading “Volume I — Ethereum” (1 of 2)");
    expect(t.state.sources.map((s) => s.state)).toEqual(["reading", "waiting"]);

    t.handleToolStart(
      {},
      JSON.stringify({ file_path: "/work/candidates/src_a.json" }),
      "t2",
      undefined,
      [],
      {},
      "write_file",
    );
    expect(t.state.sources.map((s) => s.state)).toEqual(["done", "waiting"]);
    const half = t.state.fraction;
    expect(half).toBeGreaterThan(0.3);
    expect(half).toBeLessThan(0.5);

    t.handleToolStart(
      {},
      JSON.stringify({ file_path: "/work/candidates/src_b.json" }),
      "t3",
      undefined,
      [],
      {},
      "write_file",
    );
    expect(t.state.label).toBe("Read all 2 sources");

    t.handleToolStart(
      {},
      JSON.stringify({ description: "Merge", subagent_type: "curriculum-editor" }),
      "t4",
      undefined,
      [],
      {},
      "task",
    );
    expect(t.state.stage).toBe("ordering");
    t.stage("checking", "Checking every concept against your sources", 0.95);
    expect(t.state).toMatchObject({ stage: "checking", fraction: 0.95 });

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
