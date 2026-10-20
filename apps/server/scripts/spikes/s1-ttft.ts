// Where does crowd-reactor time go: time-to-first-token or generation?
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatDeepSeek } from "@langchain/deepseek";
import { activeProfile } from "@lumen/shared";
import { dirname } from "node:path";
import { findConfigDir, loadConfig } from "../../src/config/load.js";
import { loadDotEnv } from "../../src/config/paths.js";

loadDotEnv(dirname(findConfigDir()));
const cfg = loadConfig();
const model = new ChatDeepSeek({
  model: activeProfile(cfg.models).fastest.model,
  apiKey: process.env.DEEPSEEK_API_KEY,
  modelKwargs: { thinking: { type: "disabled" }, response_format: { type: "json_object" } },
  streamUsage: true,
  maxRetries: 0,
});
const cadets = Array.from({ length: Number(process.argv[2] ?? 10) }, (_, i) => `c${i}`);
const sys = new SystemMessage(
  `Return JSON {"reactions":[{"cadetId","state"}...]} with one entry for each cadet id: ${cadets.join(", ")}. states: attentive|confused|excited|bored|skeptical|notetaking.`,
);
for (let run = 0; run < 6; run++) {
  const t0 = performance.now();
  let first = 0;
  let out = 0;
  let text = "";
  for await (const chunk of await model.stream([
    sys,
    new HumanMessage(`Teacher said: "Merkle roots live in the block header." (${run})`),
  ])) {
    if (!first && chunk.content) first = performance.now() - t0;
    text += String(chunk.content);
    out = chunk.usage_metadata?.output_tokens ?? out;
  }
  const total = performance.now() - t0;
  console.log(
    `run ${run}: TTFT ${Math.round(first)}ms · total ${Math.round(total)}ms · out ${out} tok · ${(out / ((total - first) / 1000)).toFixed(0)} tok/s · ${text.length} chars`,
  );
}
