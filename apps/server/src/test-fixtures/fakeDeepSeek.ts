import { ChatDeepSeek } from "@langchain/deepseek";
import type { ModelsConfig } from "@lumen/shared";
import { ModelFactory } from "../models/factory.js";

/**
 * A ModelFactory whose models are real ChatDeepSeek instances talking to a fake
 * fetch: `respond` gets the request body and returns the assistant content.
 * Exercises the real LangChain + JSON-mode path offline.
 */
export function fakeDeepSeekFactory(
  config: ModelsConfig,
  respond: (body: { messages: Array<{ role: string; content: string }> }) => string,
) {
  const calls: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const fetch = async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    calls.push(body);
    const content = respond(body);
    return new Response(
      JSON.stringify({
        id: "x",
        object: "chat.completion",
        created: 0,
        model: "deepseek-flash",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
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
  return { factory, calls };
}
