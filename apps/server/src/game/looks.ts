/** V4-07: the Registrar's hair description, from a cadet's traits_json ("" if none). */
export function hairOf(traitsJson: string): string {
  try {
    const t = JSON.parse(traitsJson) as { appearance?: { hair?: unknown } };
    return typeof t.appearance?.hair === "string" ? t.appearance.hair : "";
  } catch {
    return "";
  }
}
