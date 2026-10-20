/**
 * Whether an error should count against the provider and move on to the next
 * fallback. Client errors (bad schema, bad params) and cancellations should not:
 * another model would most likely fail the same way, or the caller asked to stop.
 */
export function isProviderFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError" || (/abort/i.test(err.message) && !/timeout/i.test(err.message))) {
    return false;
  }
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number") return status === 408 || status === 429 || status >= 500;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && /ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR/.test(code)) {
    return true;
  }
  return /timeout|timed out|network|socket hang up|fetch failed/i.test(err.message);
}
