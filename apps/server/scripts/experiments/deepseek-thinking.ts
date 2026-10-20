// One-off experiment (M0-07 follow-up): what works on DeepSeek with thinking on?
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { ChatDeepSeek } from "@langchain/deepseek";
import { z } from "zod";
import { activeProfile } from "@lumen/shared";
import { loadConfig } from "../../src/config/load.js";
import { loadDotEnv } from "../../src/config/paths.js";

loadDotEnv("../..");
const cfg = loadConfig().models;
const make = (thinking: "enabled" | "disabled") =>
  new ChatDeepSeek({
    model: activeProfile(cfg).fast.model,
    apiKey: process.env.DEEPSEEK_API_KEY,
    modelKwargs: { thinking: { type: thinking } },
    maxRetries: 0,
    timeout: 60_000,
  });

const Ping = z.object({ ok: z.boolean(), word: z.string() });
const msg = [new HumanMessage('Return ok=true and word="lumen". Respond in JSON.')];

for (const method of ["functionCalling", "jsonMode", "jsonSchema"] as const) {
  const t0 = performance.now();
  try {
    const out = await make("enabled")
      .withStructuredOutput(Ping, { name: "ping", method })
      .invoke(msg);
    console.log(
      `E1 thinking=on method=${method}: OK ${JSON.stringify(out)} ${Math.round(performance.now() - t0)}ms`,
    );
  } catch (e) {
    console.log(`E1 thinking=on method=${method}: FAIL ${(e as Error).message.slice(0, 140)}`);
  }
}

const add = tool(async ({ a, b }: { a: number; b: number }) => String(a + b), {
  name: "add",
  description: "Add two numbers.",
  schema: z.object({ a: z.number(), b: z.number() }),
});
for (let i = 1; i <= 3; i++) {
  const m = make("enabled").bindTools([add]);
  const q = [
    new HumanMessage(
      `Use the add tool to add ${i} and ${i * 10}. Then use it again to add the result and 7. Reply with the final number.`,
    ),
  ];
  try {
    const history: (HumanMessage | AIMessage | ToolMessage)[] = [...q];
    let steps = 0;
    let reasoned = false;
    for (;;) {
      const r = (await m.invoke(history)) as AIMessage;
      reasoned ||= Boolean(r.additional_kwargs?.reasoning_content);
      history.push(r);
      if (!r.tool_calls?.length) {
        console.log(
          `E2 run ${i}: OK after ${steps} tool steps, reasoning_content seen=${reasoned}, answer=${String(r.content).slice(0, 40)}`,
        );
        break;
      }
      for (const c of r.tool_calls) {
        steps++;
        history.push(
          new ToolMessage({
            tool_call_id: c.id!,
            content: String(await add.invoke(c.args as { a: number; b: number })),
          }),
        );
      }
      if (steps > 4) {
        console.log(`E2 run ${i}: too many steps`);
        break;
      }
    }
  } catch (e) {
    console.log(`E2 run ${i}: FAIL ${(e as Error).message.slice(0, 160)}`);
  }
}
