import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  reporter: "list",
  // One worker: frame-time tests can't share the GPU and CPU with other browsers.
  workers: 1,
  use: { baseURL: "http://localhost:5173", ...devices["Desktop Chrome"] },
  projects: [
    // Functional tests: default headless (software GL is fine for behaviour).
    { name: "default", testIgnore: /(perf|live)\.spec\.ts/ },
    // Frame-rate tests need the real GPU: new headless + ANGLE on Vulkan.
    // (Default headless renders with SwiftShader at ~4 FPS, which says nothing about the app.)
    {
      name: "gpu",
      testMatch: /(perf|live)\.spec\.ts/,
      use: {
        channel: "chromium",
        launchOptions: {
          args: [
            "--use-angle=vulkan",
            "--enable-gpu",
            "--ignore-gpu-blocklist",
            "--enable-features=Vulkan",
          ],
        },
      },
    },
  ],
  webServer: [
    {
      // The real server (no model calls happen unless a class is taught).
      command: "pnpm --filter @lumen/server start",
      url: "http://127.0.0.1:5174/api/health",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: "pnpm --filter @lumen/client dev",
      url: "http://localhost:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
