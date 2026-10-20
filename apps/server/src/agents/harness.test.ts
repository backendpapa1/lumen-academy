import { fileURLToPath } from "node:url";
import { HumanMessage } from "@langchain/core/messages";
import { ChatDeepSeek } from "@langchain/deepseek";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../config/load.js";
import { ModelFactory } from "../models/factory.js";
import { callStructured, isValidationError } from "./harness.js";
import { loadPrompt } from "./prompts/load.js";

const FIXTURES = fileURLToPath(new URL("./prompts/__fixtures__", import.meta.url));

describe("loadPrompt", () => {
  it("fills slots without HTML-escaping", () => {
    const out = loadPrompt(
      "greet",
      { name: "Ines", subject: "Merkle trees", canPeek: true, quote: `a & "b"` },
      FIXTURES,
    );
    expect(out).toContain("Hello Ines, you teach Merkle trees.");
    expect(out).toContain("You may peek.");
    expect(out).toContain(`Quote: "a & "b""`);
  });

  it("fails loudly on a missing slot", () => {
    expect(() => loadPrompt("greet", { name: "Ines" }, FIXTURES)).toThrow(
      /prompt "greet":.*subject/,
    );
  });
});

// Offline DeepSeek that answers with the given contents in order (JSON-mode path).
function scriptedFactory(contents: string[]) {
  const config = loadConfig({ env: {} }).models;
  let i = 0;
  const fetch = async () =>
    new Response(
      JSON.stringify({
        id: "x",
        object: "chat.completion",
        created: 0,
        model: "deepseek-flash",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: contents[i++] ?? "{}" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const factory = new ModelFactory({
    config,
    env: { DEEPSEEK_API_KEY: "test" },
    build: (spec) =>
      new ChatDeepSeek({
        model: spec.model,
        apiKey: "test",
        configuration: { fetch: fetch as typeof globalThis.fetch },
        modelKwargs: { thinking: { type: spec.thinking === "on" ? "enabled" : "disabled" } },
      }),
  });
  return { factory, calls: () => i };
}

const Score = z.object({ score: z.number().min(0).max(5) });

describe("callStructured", () => {
  it("returns validated data", async () => {
    const { factory } = scriptedFactory(['{"score": 4}']);
    const r = await callStructured(factory, "grader", {
      schema: Score,
      name: "score",
      messages: [new HumanMessage("grade")],
    });
    expect(r).toMatchObject({ data: { score: 4 }, reasked: false });
  });

  it("re-asks once when the output fails the schema", async () => {
    const { factory, calls } = scriptedFactory(['{"score": 9}', '{"score": 3}']);
    const r = await callStructured(factory, "grader", {
      schema: Score,
      name: "score",
      messages: [new HumanMessage("grade")],
    });
    expect(r).toMatchObject({ data: { score: 3 }, reasked: true });
    expect(calls()).toBe(2);
  });

  it("gives up after the re-ask fails too", async () => {
    const { factory } = scriptedFactory(["not json", '{"score": -1}']);
    const err = await callStructured(factory, "grader", {
      schema: Score,
      name: "score",
      messages: [new HumanMessage("grade")],
    }).catch((e: unknown) => e);
    expect(isValidationError(err)).toBe(true);
  });
});
