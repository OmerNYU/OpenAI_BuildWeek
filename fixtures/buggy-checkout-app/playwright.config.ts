import { defineConfig } from "@playwright/test";
import { createPlaywrightSettings } from "./playwright-settings.js";

export default defineConfig(createPlaywrightSettings());
