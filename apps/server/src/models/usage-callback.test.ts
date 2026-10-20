import { HumanMessage } from "@langchain/core/messages";
import { ChatDeepSeek } from "@langchain/deepseek";
import { ChatOpenAI } from "@langchain/openai";
import { describe, expect, it } from "vitest";
import type { UsageEvent } from "../usage/meter.js";
import { UsageCallback } from "./usage-callback.js";
import type { ResolvedSpec } from "./spec.js";

// Canned provider responses so the real LangChain → callback path runs offline.
// ChatOpenAI routes gpt-5.x to the Responses API; DeepSeek uses Chat Completions.
const RESPONSES_BODY = {
  id: "resp_1",
  object: "response",
  created_at: 0,
  model: "m",
  status: "completed",
  output: [
    {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "hi", annotations: [] }],
    },
  ],
  usage: {
    input_tokens: 1200,
    input_tokens_details: { cached_tokens: 1000 },
    output_tokens: 30,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 1230,
  },
};

function fakeFetch(bodies: unknown[], urls: string[] = []) {
  return async (url: unknown, init?: { body?: unknown }) => {
    urls.push(String(url));
    bodies.push(JSON.parse(String(init?.body)));
    if (String(url).endsWith("/responses")) {
      return new Response(JSON.stringify(RESPONSES_BODY), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        id: "c1",
        object: "chat.completion",
        created: 0,
        model: "m",
        choices: [
          { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" },
        ],
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 30,
          total_tokens: 1230,
          prompt_tokens_details: { cached_tokens: 1000 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

const spec = (over: Partial<ResolvedSpec>): ResolvedSpec => ({
  agent: "cadetTalk",
  role: "fast",
  provider: "openai",
  model: "gpt-5.6-luna",
  isFallback: false,
  ...over,
});

describe("UsageCallback (end to end through LangChain, offline)", () => {
  it("records tokens, cached tokens and latency for ChatOpenAI", async () => {
    const events: UsageEvent[] = [];
    const bodies: unknown[] = [];
    const urls: string[] = [];
    const s = spec({});
    const model = new ChatOpenAI({
      model: s.model,
      apiKey: "test",
      configuration: { fetch: fakeFetch(bodies, urls) as typeof fetch },
      callbacks: [new UsageCallback(s, { record: (e) => events.push(e) })],
    });
    await model.invoke([new HumanMessage("hello")]);
    expect(urls[0]).toMatch(/\/responses$/); // gpt-5.x → Responses API (ADR-004)
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agent: "cadetTalk",
      provider: "openai",
      model: "gpt-5.6-luna",
      inputTokens: 1200,
      outputTokens: 30,
      cachedTokens: 1000,
      fallbackUsed: false,
    });
    expect(events[0]?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("sends the DeepSeek thinking flag in the request body (ADR-004)", async () => {
    const events: UsageEvent[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    const s = spec({
      provider: "deepseek",
      model: "deepseek-flash",
      thinking: "off",
      isFallback: true,
    });
    const model = new ChatDeepSeek({
      model: s.model,
      apiKey: "test",
      configuration: { fetch: fakeFetch(bodies) as typeof fetch },
      modelKwargs: { thinking: { type: "disabled" } },
      callbacks: [new UsageCallback(s, { record: (e) => events.push(e) })],
    });
    await model.invoke([new HumanMessage("hello")]);
    expect(bodies[0]?.thinking).toEqual({ type: "disabled" });
    expect(events[0]).toMatchObject({
      provider: "deepseek",
      inputTokens: 1200,
      fallbackUsed: true,
    });
  });
});
