import { test as base, expect } from "@playwright/test";

// Part B: the same flows on phones. In the phone projects a spec's own
// setViewportSize (written for the desktop) is ignored, so every flow runs at
// the project's portrait or landscape size, with touch. A spec can opt out of
// a phone layout with `test.skip(phone(testInfo), "why")`.

export const test = base.extend<{ phoneViewport: void }>({
  phoneViewport: [
    async ({ page }, use, info) => {
      if (info.project.metadata?.phone) {
        page.setViewportSize = async () => undefined;
        // Phone screenshots go beside the desktop ones: docs/screens/<project>/…
        const shot = page.screenshot.bind(page);
        page.screenshot = (o = {}) =>
          shot(
            o.path
              ? { ...o, path: o.path.replace(/(^|\/)screens\//, `$1screens/${info.project.name}/`) }
              : o,
          );
      }
      await use();
    },
    { auto: true },
  ],
});

export const phone = (info: { project: { metadata?: Record<string, unknown> } }) =>
  !!info.project.metadata?.phone;

export { expect };
