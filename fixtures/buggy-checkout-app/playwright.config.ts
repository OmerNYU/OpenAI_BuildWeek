import { defineConfig } from "@playwright/test";
import { createPlaywrightSettings } from "./playwright-settings.js";

const runnerEnvironment = {
  FAILSPEC_BASE_URL: process.env.FAILSPEC_BASE_URL,
  FAILSPEC_MANAGED_SERVER: process.env.FAILSPEC_MANAGED_SERVER
};

export default defineConfig(createPlaywrightSettings(runnerEnvironment));
