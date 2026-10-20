import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { RunnableLambda, type Runnable } from "@langchain/core/runnables";
import { z } from "zod";
import type { ResolvedSpec } from "./spec.js";

/**
 * Structured output that works on every provider/mode we use (ADR-004):
 * - DeepSeek with thinking on rejects forced tool_choice (function calling) and
 *   json_schema response formats. JSON mode works, but the model only sees the
 *   schema if we put it in the prompt, so we prepend it.
 * - Everything else uses LangChain's default (function calling).
 * Output is always validated against the Zod schema.
 */
export function structured<T extends Record<string, unknown>>(
  candidate: { model: BaseChatModel; spec: ResolvedSpec },
  schema: z.ZodType<T>,
  name: string,
): Runnable<BaseMessage[], T> {
  const { model, spec } = candidate;
  if (spec.provider === "deepseek" && spec.thinking === "on") {
    const instruction = new SystemMessage(
      `Respond with a single JSON object and nothing else. It must match this JSON Schema (name: ${name}):\n` +
        JSON.stringify(z.toJSONSchema(schema)),
    );
    const jsonModel = model.withStructuredOutput(schema, { name, method: "jsonMode" });
    return RunnableLambda.from(async (messages: BaseMessage[]) =>
      schema.parse(await jsonModel.invoke([instruction, ...messages])),
    );
  }
  const fnModel = model.withStructuredOutput(schema, { name });
  return RunnableLambda.from(async (messages: BaseMessage[]) =>
    schema.parse(await fnModel.invoke(messages)),
  );
}
