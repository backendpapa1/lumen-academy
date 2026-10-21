// Bundled web fonts (offline-friendly; ADR-009). Text must not render before
// these load, or it falls back and measures wrong.
import "@fontsource/bungee/400.css";
import "@fontsource/space-mono/400.css";
import "@fontsource/space-mono/700.css";
import "@fontsource/atkinson-hyperlegible-next/400.css";
import "@fontsource/atkinson-hyperlegible-next/600.css";
import "@fontsource/atkinson-hyperlegible-next/700.css";
import "./style/tokens.css";
import "./style/base.css";

export async function loadFonts(): Promise<void> {
  const faces = [
    '400 16px "Bungee"',
    '400 16px "Space Mono"',
    '700 16px "Space Mono"',
    '400 16px "Atkinson Hyperlegible Next"',
    '600 16px "Atkinson Hyperlegible Next"',
    '700 16px "Atkinson Hyperlegible Next"',
  ];
  await Promise.all(faces.map((f) => document.fonts.load(f)));
  await document.fonts.ready;
}
