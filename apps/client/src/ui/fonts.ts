// Bundled web fonts (offline-friendly; docs/08 §2). Phaser text must not render
// before these load, or it falls back and measures wrong.
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/600.css";

export async function loadFonts(): Promise<void> {
  const faces = [
    '500 16px "Space Grotesk"',
    '700 16px "Space Grotesk"',
    '400 16px "Inter"',
    '500 16px "Inter"',
    '600 16px "Inter"',
    '400 16px "JetBrains Mono"',
    '600 16px "JetBrains Mono"',
  ];
  await Promise.all(faces.map((f) => document.fonts.load(f)));
  await document.fonts.ready;
}
