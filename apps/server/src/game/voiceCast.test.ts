import { afterEach, describe, expect, it } from "vitest";
import { registerFor } from "@lumen/shared";
import { loadConfig } from "../config/load.js";
import type { DbHandle } from "../db/client.js";
import { agentOf, fakeDeepSeekFactory } from "../test-fixtures/fakeDeepSeek.js";
import { smallWorld } from "../test-fixtures/world.js";
import { UsageMeter } from "../usage/meter.js";
import { registerOf } from "./looks.js";
import { castVoices, uncast } from "./voiceCast.js";

const cfg = loadConfig({ env: {} });
const handles: DbHandle[] = [];
afterEach(() => handles.splice(0).forEach((h) => h.close()));

describe("voice register follows the name (note fix)", () => {
  it("prefers the Registrar's note, then the presentation, then the id", () => {
    expect(registerFor("cdt_x", { voice: "higher", genderPresentation: "masculine" })).toBe(
      "female",
    );
    expect(registerFor("cdt_x", { voice: "lower" })).toBe("male");
    expect(registerFor("cdt_x", { genderPresentation: "feminine" })).toBe("female");
    expect(registerFor("cdt_x", { genderPresentation: "masculine" })).toBe("male");
    expect(["female", "male"]).toContain(
      registerFor("cdt_x", { genderPresentation: "androgynous" }),
    );
  });

  it("casts a fitting voice for older androgynous students only, once", async () => {
    const w = await smallWorld([
      { attention: 0.5, skepticism: 0.5 },
      { attention: 0.5, skepticism: 0.5 },
      { attention: 0.5, skepticism: 0.5 },
    ]);
    handles.push(w.handle);
    const set = (id: string, name: string, presentation: string) =>
      w.handle.sqlite
        .prepare("UPDATE cadets SET name = ?, traits_json = ? WHERE id = ?")
        .run(
          name,
          JSON.stringify({ appearance: { genderPresentation: presentation, hair: "long" } }),
          id,
        );
    const [a, b, c] = w.cadets.map((x) => x.id) as [string, string, string];
    set(a, "Sofia Marchetti", "androgynous");
    set(b, "Daniyar Sarsenov", "androgynous");
    set(c, "Elena Rossi", "feminine");
    expect(
      uncast(w.handle)
        .map((r) => r.id)
        .sort(),
    ).toEqual([a, b].sort());

    const meter = new UsageMeter({
      db: w.handle.db,
      pricing: cfg.pricing,
      budget: cfg.models.budget,
    });
    const seen: string[] = [];
    const { factory } = fakeDeepSeekFactory(
      cfg.models,
      (body) => {
        seen.push(agentOf(body) ?? "?");
        const prompt = body.messages.map((m) => m.content).join("\n");
        // Whatever order the students are listed in, Sofia is higher and Daniyar lower.
        const students = [...prompt.matchAll(/^(\d+)\. ([^:]+):/gm)].map((m) => ({
          index: Number(m[1]),
          voice: m[2]!.startsWith("Sofia") ? "higher" : "lower",
        }));
        return JSON.stringify({ students });
      },
      { meter },
    );
    expect(await castVoices({ handle: w.handle, factory })).toBe(2);
    const t = (id: string) =>
      (
        w.handle.sqlite.prepare("SELECT traits_json t FROM cadets WHERE id = ?").get(id) as {
          t: string;
        }
      ).t;
    expect(registerOf(a, t(a))).toBe("female");
    expect(registerOf(b, t(b))).toBe("male");
    expect(registerOf(c, t(c))).toBe("female");
    expect(uncast(w.handle)).toEqual([]);
    expect(await castVoices({ handle: w.handle, factory })).toBe(0);
    expect(seen.filter((s) => s === "voiceCaster")).toHaveLength(1);
  });
});
