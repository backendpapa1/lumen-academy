import { describe, expect, it } from "vitest";
import { loadConfig } from "../../config/load.js";
import { fakeDeepSeekFactory } from "../../test-fixtures/fakeDeepSeek.js";
import { writeRecap } from "./recap.js";

const cfg = loadConfig({ env: {} });

describe("writeRecap", () => {
  it.each(["**Last time…**\n- a", "## Next time...\n- a", "Last time:\n\n- a", "- a"])(
    "strips a leading heading: %j",
    async (reply) => {
      const { factory } = fakeDeepSeekFactory(cfg.models, () => reply);
      expect(await writeRecap(factory, { kind: "in", teacherLines: ["x"], weakConcepts: [] })).toBe(
        "- a",
      );
    },
  );
});
