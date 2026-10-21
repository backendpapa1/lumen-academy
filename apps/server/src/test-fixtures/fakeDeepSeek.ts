import { ChatDeepSeek } from "@langchain/deepseek";
import type { ModelsConfig } from "@lumen/shared";
import { ModelFactory } from "../models/factory.js";
import { UsageCallback } from "../models/usage-callback.js";
import type { UsageMeter } from "../usage/meter.js";

export interface FakeRequest {
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  tools?: unknown[];
}

/** A scripted reply: plain text, or tool calls (streamed as tool_call deltas). */
export type FakeReply =
  string | { toolCalls: Array<{ name: string; args: Record<string, unknown> }> };

const chunk = (delta: unknown, extra: Record<string, unknown> = {}) => ({
  id: "x",
  object: "chat.completion.chunk",
  created: 0,
  model: "deepseek-flash",
  choices: [{ index: 0, delta, finish_reason: null }],
  ...extra,
});

/**
 * A ModelFactory whose models are real ChatDeepSeek instances talking to a fake
 * fetch: `respond` gets the request body and returns the reply (or throws to
 * simulate a provider error). Streaming requests get an SSE response split into
 * small chunks, so the real LangChain stream and tool-call paths run.
 */
export function fakeDeepSeekFactory(
  config: ModelsConfig,
  respond: (body: FakeRequest) => FakeReply | Promise<FakeReply>,
  opts: { meter?: UsageMeter } = {},
) {
  const calls: FakeRequest[] = [];
  const fetch = async (_url: unknown, init?: { body?: unknown; signal?: AbortSignal }) => {
    const body = JSON.parse(String(init?.body)) as FakeRequest;
    calls.push(body);
    const reply = await respond(body);
    if (init?.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const content = typeof reply === "string" ? reply : "";
    const toolCalls = typeof reply === "string" ? [] : reply.toolCalls;
    const usage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 };
    if (body.stream) {
      const deltas = toolCalls.length
        ? toolCalls.map((t, i) =>
            chunk({
              tool_calls: [
                {
                  index: i,
                  id: `call_${i}`,
                  type: "function",
                  function: { name: t.name, arguments: JSON.stringify(t.args) },
                },
              ],
            }),
          )
        : (content.match(/[\s\S]{1,7}/g) ?? [""]).map((p) => chunk({ content: p }));
      const done = {
        ...chunk({}),
        choices: [{ index: 0, delta: {}, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
        usage,
      };
      // Real APIs send the role in the first delta; LangChain needs it to type the chunks.
      const opening = chunk({ role: "assistant", content: "" });
      const sse =
        [opening, ...deltas, done].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") +
        "data: [DONE]\n\n";
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const message = toolCalls.length
      ? {
          role: "assistant",
          content: "",
          tool_calls: toolCalls.map((t, i) => ({
            id: `call_${i}`,
            type: "function",
            function: { name: t.name, arguments: JSON.stringify(t.args) },
          })),
        }
      : { role: "assistant", content };
    return new Response(
      JSON.stringify({
        id: "x",
        object: "chat.completion",
        created: 0,
        model: "deepseek-flash",
        choices: [{ index: 0, message, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
        usage,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const factory = new ModelFactory({
    config,
    env: { DEEPSEEK_API_KEY: "test" },
    ...(opts.meter ? { meter: opts.meter } : {}),
    build: (spec) =>
      new ChatDeepSeek({
        model: spec.model,
        apiKey: "test",
        configuration: { fetch: fetch as typeof globalThis.fetch },
        modelKwargs: { thinking: { type: spec.thinking === "on" ? "enabled" : "disabled" } },
        maxRetries: 0,
        ...(opts.meter ? { callbacks: [new UsageCallback(spec, opts.meter)] } : {}),
      }),
  });
  return { factory, calls };
}

/** Which agent a request is for, from its system prompts. */
export const agentOf = (body: FakeRequest) => {
  // JSON-mode calls prepend a schema system message, so look at all of them.
  const sys = body.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
  if (sys.includes("You direct the crowd")) return "crowdReactor";
  if (sys.includes("You are the Class Director")) return "classDirector";
  if (sys.includes("You are the Registrar")) return "registrar";
  if (sys.includes("You design emblems")) return "artDirector";
  if (sys.includes("You are the Examiner")) return "examiner";
  if (sys.includes("You are the Debrief Analyst")) return "debriefAnalyst";
  if (sys.includes("You grade a student's answer")) return "grader";
  if (/You are .+, a cadet at Lumen Academy/.test(sys) && sys.includes("You are answering a"))
    return "cadetAnswer";
  if (
    /You are .+, a cadet at Lumen Academy/.test(sys) &&
    sys.includes("The Headmaster just called on you")
  ) {
    return "cadet";
  }
  return "other";
};
