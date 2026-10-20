import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  reporter: "list",
  use: { baseURL: "http://localhost:5173", ...devices["Desktop Chrome"] },
  webServer: {
    command: "pnpm --filter @lumen/client dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
