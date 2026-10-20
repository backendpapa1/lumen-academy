import { ChatDeepSeek } from "@langchain/deepseek";
import type { ModelsConfig } from "@lumen/shared";
import { ModelFactory } from "../models/factory.js";

export interface FakeRequest {
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
}

/**
 * A ModelFactory whose models are real ChatDeepSeek instances talking to a fake
 * fetch: `respond` gets the request body and returns the assistant content
 * (or throws to simulate a provider error). Streaming requests get an SSE
 * response split into small chunks, so the real LangChain stream path runs.
 */
export function fakeDeepSeekFactory(
  config: ModelsConfig,
  respond: (body: FakeRequest) => string | Promise<string>,
) {
  const calls: FakeRequest[] = [];
  const fetch = async (_url: unknown, init?: { body?: unknown; signal?: AbortSignal }) => {
    const body = JSON.parse(String(init?.body)) as FakeRequest;
    calls.push(body);
    const content = await respond(body);
    if (init?.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const usage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 };
    if (body.stream) {
      const pieces = content.match(/[\s\S]{1,7}/g) ?? [""];
      const events = [
        ...pieces.map((p) => ({
          id: "x",
          object: "chat.completion.chunk",
          created: 0,
          model: "deepseek-flash",
          choices: [{ index: 0, delta: { content: p }, finish_reason: null }],
        })),
        {
          id: "x",
          object: "chat.completion.chunk",
          created: 0,
          model: "deepseek-flash",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage,
        },
      ];
      const sse = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(
      JSON.stringify({
        id: "x",
        object: "chat.completion",
        created: 0,
        model: "deepseek-flash",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage,
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
        maxRetries: 0,
      }),
  });
  return { factory, calls };
}

/** Which agent a request is for, from its system prompt. */
export const agentOf = (body: FakeRequest) => {
  // JSON-mode calls prepend a schema system message, so look at all of them.
  const sys = body.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
  if (sys.includes("You direct the crowd")) return "crowdReactor";
  if (sys.includes("You are the Class Director")) return "classDirector";
  if (sys.includes("You are the Registrar")) return "registrar";
  return "other";
};
