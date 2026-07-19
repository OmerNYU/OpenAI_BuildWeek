import { defineConfig } from "@playwright/test";

const baseURL = process.env.FAILSPEC_BASE_URL ?? "http://127.0.0.1:3100";
const runnerManagedServer = process.env.FAILSPEC_MANAGED_SERVER === "1";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  use: {
    baseURL
  },
  webServer: runnerManagedServer
    ? undefined
    : {
        command: "npm run dev -- --hostname 127.0.0.1 --port 3100",
        port: 3100,
        reuseExistingServer: false
      }
});
