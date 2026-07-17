import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:3100"
  },
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3100",
    port: 3100,
    reuseExistingServer: false
  }
});
