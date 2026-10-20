import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { RunnableLambda, type Runnable } from "@langchain/core/runnables";
import { z } from "zod";
import type { ResolvedSpec } from "./spec.js";

/**
 * Structured output that works on every provider/mode we use (ADR-004):
 * - DeepSeek (any thinking mode) uses JSON mode with the schema in the prompt.
 *   With thinking on, forced tool_choice and json_schema are rejected; with it
 *   off, function calling sometimes returns no tool call at all (spike M1-S1),
 *   while JSON mode always returns a JSON object.
 * - Everything else uses LangChain's default (function calling).
 * Output is always validated against the Zod schema.
 */
export function structured<T extends Record<string, unknown>>(
  candidate: { model: BaseChatModel; spec: ResolvedSpec },
  schema: z.ZodType<T>,
  name: string,
): Runnable<BaseMessage[], T> {
  const { model, spec } = candidate;
  if (spec.provider === "deepseek") {
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
