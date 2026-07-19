export function createPlaywrightSettings(environment: NodeJS.ProcessEnv = process.env) {
  const baseURL = environment.FAILSPEC_BASE_URL ?? "http://127.0.0.1:3100";
  const runnerManagedServer = environment.FAILSPEC_MANAGED_SERVER === "1";

  return {
    testDir: "./tests",
    timeout: 30_000,
    use: { baseURL },
    webServer: runnerManagedServer
      ? undefined
      : {
          command: "npm run dev -- --hostname 127.0.0.1 --port 3100",
          port: 3100,
          reuseExistingServer: false
        }
  };
}
