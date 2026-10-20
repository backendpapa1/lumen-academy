// Does reasoning_effort (low/high) reach DeepSeek via ChatDeepSeek, and is gpt-image-1-mini listed?
import { HumanMessage } from "@langchain/core/messages";
import { ChatDeepSeek } from "@langchain/deepseek";
import { loadConfig } from "../../src/config/load.js";
import { loadDotEnv } from "../../src/config/paths.js";
import { listProviderModels } from "../../src/models/check.js";

loadDotEnv("../..");
const cfg = loadConfig().models;
const bodies: unknown[] = [];
const spyFetch: typeof fetch = async (url, init) => {
  bodies.push(JSON.parse(String(init?.body)));
  return fetch(url, init);
};
for (const effort of ["low", "high"] as const) {
  const m = new ChatDeepSeek({
    model: "deepseek-flash",
    apiKey: process.env.DEEPSEEK_API_KEY,
    configuration: { fetch: spyFetch },
    modelKwargs: { thinking: { type: "enabled" }, reasoning_effort: effort },
    maxRetries: 0,
  });
  const t0 = performance.now();
  const r = await m.invoke([new HumanMessage("Is 391 prime? Answer yes or no.")]);
  const body = bodies.at(-1) as Record<string, unknown>;
  console.log(
    `effort=${effort}: sent reasoning_effort=${String(body.reasoning_effort)} · ${Math.round(performance.now() - t0)}ms · reasoning chars=${String(r.additional_kwargs.reasoning_content ?? "").length} · answer=${String(r.content).slice(0, 30)}`,
  );
}
const openai = await listProviderModels(cfg, "openai", process.env.OPENAI_API_KEY!);
console.log(
  "gpt-image-1-mini listed:",
  openai.has("gpt-image-1-mini"),
  "| gpt-image-1 listed:",
  openai.has("gpt-image-1"),
);
