import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, findConfigDir, loadConfig } from "./load.js";

const realConfigDir = findConfigDir(import.meta.dirname);

function tempConfig(edit?: (file: string, text: string) => string): string {
  const dir = mkdtempSync(join(tmpdir(), "lumen-config-"));
  cpSync(realConfigDir, dir, { recursive: true });
  if (edit) {
    for (const file of ["models.yaml", "pricing.yaml", "game.yaml", "art-prompts.yaml"]) {
      const path = join(dir, file);
      writeFileSync(path, edit(file, readFileSync(path, "utf8")));
    }
  }
  return dir;
}

describe("loadConfig", () => {
  it("loads and validates the committed config", () => {
    const cfg = loadConfig({ configDir: realConfigDir, env: {} });
    expect(cfg.models.profile).toBe("hybrid");
    expect(cfg.models.agents.crowdReactor.role).toBe("fastest");
    expect(cfg.models.agents.classDirector.role).toBe("standard");
    expect(cfg.game.comprehension.base).toBe(0.22);
    expect(cfg.pricing.deepseek.timeOfDay?.tz).toBe("Asia/Shanghai");
    expect(cfg.env.LUMEN_PORT).toBe(5174);
  });

  it("lets LUMEN_PROFILE override the profile", () => {
    const cfg = loadConfig({ configDir: realConfigDir, env: { LUMEN_PROFILE: "deepseek" } });
    expect(cfg.models.profile).toBe("deepseek");
  });

  it("rejects an unknown LUMEN_PROFILE with a readable error", () => {
    expect(() =>
      loadConfig({ configDir: realConfigDir, env: { LUMEN_PROFILE: "gemini" } }),
    ).toThrow(/environment[\s\S]*LUMEN_PROFILE/);
  });

  it("names the file and path of an invalid value", () => {
    const dir = tempConfig((file, text) =>
      file === "models.yaml"
        ? text.replace(
            "provider: deepseek, model: deepseek-v4-pro",
            "provider: anthropic, model: x",
          )
        : text,
    );
    try {
      loadConfig({ configDir: dir, env: {} });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).file).toBe("models.yaml");
      expect((err as Error).message).toContain("profiles.deepseek.heavy.provider");
    }
  });

  it("requires an entry for every agent", () => {
    const dir = tempConfig((file, text) =>
      file === "models.yaml" ? text.replace(/^ {2}grader:.*\n/m, "") : text,
    );
    expect(() => loadConfig({ configDir: dir, env: {} })).toThrow(/agents\.grader: Invalid input/);
  });

  it("rejects a malformed fallback id", () => {
    const dir = tempConfig((file, text) =>
      file === "models.yaml"
        ? text.replace("fastest: [openai:gpt-5.4-nano", "fastest: [gpt-5.4-nano")
        : text,
    );
    expect(() => loadConfig({ configDir: dir, env: {} })).toThrow(/fallbacks\.fastest\.0/);
  });

  it("rejects non-openai embeddings", () => {
    const dir = tempConfig((file, text) =>
      file === "models.yaml"
        ? text.replace(
            "embeddings: { provider: openai, model: text-embedding-3-small }",
            "embeddings: { provider: deepseek, model: text-embedding-3-small }",
          )
        : text,
    );
    expect(() => loadConfig({ configDir: dir, env: {} })).toThrow(/embeddings must use openai/);
  });

  it("rejects an inconsistent cohort in game.yaml", () => {
    const dir = tempConfig((file, text) =>
      file === "game.yaml"
        ? text.replace(
            "cohort: { min: 4, mode: 9, max: 15 }",
            "cohort: { min: 9, mode: 4, max: 15 }",
          )
        : text,
    );
    expect(() => loadConfig({ configDir: dir, env: {} })).toThrow(
      /game\.yaml[\s\S]*min <= mode <= max/,
    );
  });

  it("reports YAML syntax errors with the file name", () => {
    const dir = tempConfig((file, text) => (file === "pricing.yaml" ? `${text}\n  : : bad` : text));
    expect(() => loadConfig({ configDir: dir, env: {} })).toThrow(/pricing\.yaml/);
  });
});

describe("committed pricing", () => {
  it("prices every model the config can route to", () => {
    const cfg = loadConfig({ configDir: realConfigDir, env: {} });
    for (const profile of Object.values(cfg.models.profiles)) {
      for (const spec of Object.values(profile)) {
        const price = cfg.pricing[spec.provider].models[spec.model];
        expect(price, `${spec.provider}:${spec.model}`).toBeDefined();
        expect(JSON.stringify(price), `${spec.provider}:${spec.model}`).not.toContain("null");
      }
    }
  });
});
