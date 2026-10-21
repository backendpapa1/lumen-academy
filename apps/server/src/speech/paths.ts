import { homedir } from "node:os";

/** `~/x` → `$HOME/x`; an env override wins (speech paths are per machine). */
export function machinePath(value: string, override?: string): string {
  const v = override?.trim() || value;
  return v.startsWith("~/") ? `${homedir()}${v.slice(1)}` : v;
}
