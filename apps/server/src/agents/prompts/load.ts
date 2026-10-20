import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Handlebars from "handlebars";

// Prompts are files (CLAUDE.md): src/agents/prompts/<name>.md with {{handlebars}} slots.
const PROMPTS_DIR = fileURLToPath(new URL(".", import.meta.url));
const cache = new Map<string, HandlebarsTemplateDelegate>();

// Prompts are plain text, never HTML: no escaping of quotes or ampersands.
const hb = Handlebars.create();

export function loadPrompt(
  name: string,
  vars: Record<string, unknown> = {},
  dir = PROMPTS_DIR,
): string {
  const key = `${dir}:${name}`;
  let template = cache.get(key);
  if (!template) {
    template = hb.compile(readFileSync(`${dir}/${name}.md`, "utf8"), {
      strict: true,
      noEscape: true,
    });
    cache.set(key, template);
  }
  try {
    return template(vars).trim();
  } catch (err) {
    throw new Error(`prompt "${name}": ${(err as Error).message}`, { cause: err });
  }
}
