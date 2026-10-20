import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { AgentName } from "@lumen/shared";
import { ZodError, type z } from "zod";
import type { Candidate, ModelFactory } from "../models/factory.js";
import type { ResolveOptions } from "../models/spec.js";
import { structured } from "../models/structured.js";

export interface StructuredCall<T> {
  schema: z.ZodType<T>;
  /** Tool/schema name shown to the model. */
  name: string;
  messages: BaseMessage[];
  signal?: AbortSignal;
  resolve?: ResolveOptions;
}

export interface StructuredResult<T> {
  data: T;
  candidate: Candidate;
  /** True when the first answer failed validation and the re-ask fixed it. */
  reasked: boolean;
  /** Why the first answer was rejected, when reasked. */
  reaskReason?: string;
}

/** Output that parsed badly or failed the schema: worth one re-ask, not a fallback. */
export function isValidationError(err: unknown): boolean {
  if (err instanceof ZodError) return true;
  const e = err as { name?: string; lc_error_code?: string } | undefined;
  return e?.name === "OutputParserException" || e?.lc_error_code === "OUTPUT_PARSING_FAILURE";
}

function describe(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
  }
  return (err as Error).message.slice(0, 500);
}

/**
 * Every agent output the game consumes goes through here (CLAUDE.md): routed by
 * the factory (fallbacks, budget, usage), parsed per provider mode, validated
 * with Zod, and re-asked once with the validation error appended (docs/03 §3.1).
 */
export async function callStructured<T extends Record<string, unknown>>(
  factory: ModelFactory,
  agent: AgentName,
  call: StructuredCall<T>,
): Promise<StructuredResult<T>> {
  return factory.run(
    agent,
    async (candidate) => {
      const runnable = structured(candidate, call.schema, call.name);
      const opts = call.signal ? { signal: call.signal } : {};
      try {
        return { data: await runnable.invoke(call.messages, opts), candidate, reasked: false };
      } catch (err) {
        if (!isValidationError(err)) throw err;
        const reaskReason = describe(err);
        const fix = new HumanMessage(
          `Your previous answer was invalid: ${reaskReason}. Reply again with corrected output only.`,
        );
        return {
          data: await runnable.invoke([...call.messages, fix], opts),
          candidate,
          reasked: true,
          reaskReason,
        };
      }
    },
    call.resolve,
  );
}
