import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/load.js";
import { MULTI_PROVIDER_CONFIG_DIR } from "../test-fixtures/index.js";
import { checkModelIds, configuredModelIds } from "./check.js";

const cfg = loadConfig({ configDir: MULTI_PROVIDER_CONFIG_DIR, env: {} }).models;
const committed = loadConfig({ env: {} }).models;
const env = { OPENAI_API_KEY: "k1", DEEPSEEK_API_KEY: "k2" };

function modelsFetch(lists: Record<string, string[]>, seen: string[] = []) {
  return async (url: string, init?: RequestInit) => {
    seen.push(`${url} ${new Headers(init?.headers).get("authorization")}`);
    const host = new URL(url).host;
    const ids = lists[host];
    if (!ids) return new Response("nope", { status: 401 });
    return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
  };
}

const OPENAI = [
  "gpt-5.4-nano",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "text-embedding-3-small",
  "gpt-image-2",
  "extra",
];
const DEEPSEEK = ["deepseek-flash", "deepseek-v4-pro"];

describe("configuredModelIds", () => {
  it("committed config uses only deepseek-flash, text-embedding-3-small and gpt-image-1-mini (ADR-007)", () => {
    const ids = configuredModelIds(committed);
    expect([...ids.deepseek]).toEqual(["deepseek-flash"]);
    expect([...ids.openai].sort()).toEqual(["gpt-image-1-mini", "text-embedding-3-small"]);
  });

  it("collects ids from every profile and fallback chain", () => {
    const ids = configuredModelIds(cfg);
    expect([...ids.openai].sort()).toEqual(OPENAI.filter((m) => m !== "extra").sort());
    expect([...ids.deepseek].sort()).toEqual(DEEPSEEK);
  });
});

describe("checkModelIds", () => {
  it("passes when every id is listed, and authenticates per provider", async () => {
    const seen: string[] = [];
    const lines = await checkModelIds(
      cfg,
      env,
      modelsFetch({ "api.openai.com": OPENAI, "api.deepseek.com": DEEPSEEK }, seen),
    );
    expect(lines.every((l) => l.ok)).toBe(true);
    expect(seen).toEqual([
      "https://api.openai.com/v1/models Bearer k1",
      "https://api.deepseek.com/models Bearer k2",
    ]);
  });

  it("fails loudly on an unknown id", async () => {
    const lines = await checkModelIds(
      cfg,
      env,
      modelsFetch({
        "api.openai.com": OPENAI.filter((m) => m !== "gpt-5.6-terra"),
        "api.deepseek.com": DEEPSEEK,
      }),
    );
    const bad = lines.filter((l) => !l.ok);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ label: "openai:gpt-5.6-terra" });
    expect(bad[0]?.detail).toMatch(/UNKNOWN/);
  });

  it("reports a missing key or an auth failure without leaking the key", async () => {
    const lines = await checkModelIds(cfg, { OPENAI_API_KEY: "secret-key" }, modelsFetch({}));
    expect(lines.map((l) => [l.label, l.ok])).toEqual([
      ["openai", false],
      ["deepseek", false],
    ]);
    expect(lines[0]?.detail).toMatch(/HTTP 401/);
    expect(lines[1]?.detail).toMatch(/DEEPSEEK_API_KEY is not set/);
    expect(JSON.stringify(lines)).not.toContain("secret-key");
  });
});
