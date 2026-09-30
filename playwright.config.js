import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:43189",
    timezoneId: "Pacific/Honolulu",
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure"
  },
  webServer: {
    command: "npm run preview",
    url: "http://127.0.0.1:43189",
    reuseExistingServer: false
  }
});
