import { describe, expect, it } from "vitest";
import { createPlaywrightSettings } from "../../../fixtures/buggy-checkout-app/playwright-settings.js";

describe("buggy checkout Playwright configuration", () => {
  it("retains the standalone loopback server when runner variables are absent", () => {
    expect(createPlaywrightSettings({})).toMatchObject({
      use: { baseURL: "http://127.0.0.1:3100" },
      webServer: {
        command: "npm run dev -- --hostname 127.0.0.1 --port 3100",
        port: 3100,
        reuseExistingServer: false
      }
    });
  });

  it("uses the runner URL and disables its web server when runner-managed", () => {
    expect(createPlaywrightSettings({
      FAILSPEC_BASE_URL: "http://127.0.0.1:43210",
      FAILSPEC_MANAGED_SERVER: "1"
    })).toMatchObject({
      use: { baseURL: "http://127.0.0.1:43210" },
      webServer: undefined
    });
  });
});
