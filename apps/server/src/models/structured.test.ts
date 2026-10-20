import { HumanMessage } from "@langchain/core/messages";
import { ChatDeepSeek } from "@langchain/deepseek";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ResolvedSpec } from "./spec.js";
import { structured } from "./structured.js";

const Ping = z.object({ ok: z.boolean(), word: z.string() });

// Offline DeepSeek: records request bodies and answers like the real API would.
function deepseek(thinking: "on" | "off", bodies: Array<Record<string, unknown>>) {
  const fetch = async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const message = body.tools
      ? {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "ping", arguments: '{"ok":true,"word":"lumen"}' },
            },
          ],
        }
      : { role: "assistant", content: '{"ok":true,"word":"lumen"}' };
    return new Response(
      JSON.stringify({
        id: "x",
        object: "chat.completion",
        created: 0,
        model: "deepseek-flash",
        choices: [{ index: 0, message, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const spec = {
    agent: "classDirector",
    role: "standard",
    provider: "deepseek",
    model: "deepseek-flash",
    thinking,
    isFallback: false,
  } as ResolvedSpec;
  const model = new ChatDeepSeek({
    model: spec.model,
    apiKey: "test",
    configuration: { fetch: fetch as typeof globalThis.fetch },
    modelKwargs: { thinking: { type: thinking === "on" ? "enabled" : "disabled" } },
  });
  return { model, spec };
}

describe("structured", () => {
  it("uses JSON mode with the schema in the prompt for DeepSeek thinking (no tool_choice)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const out = await structured(deepseek("on", bodies), Ping, "ping").invoke([
      new HumanMessage("hi"),
    ]);
    expect(out).toEqual({ ok: true, word: "lumen" });
    const body = bodies[0]!;
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain('"word"');
  });

  it("uses JSON mode for DeepSeek with thinking off too (spike M1-S1)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const out = await structured(deepseek("off", bodies), Ping, "ping").invoke([
      new HumanMessage("hi"),
    ]);
    expect(out).toEqual({ ok: true, word: "lumen" });
    expect(bodies[0]?.response_format).toEqual({ type: "json_object" });
    expect(bodies[0]?.tools).toBeUndefined();
  });
});
