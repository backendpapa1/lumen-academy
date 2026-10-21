import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  reporter: "list",
  use: { baseURL: "http://localhost:5173", ...devices["Desktop Chrome"] },
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
