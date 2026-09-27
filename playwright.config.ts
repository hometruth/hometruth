import { defineConfig, devices } from "@playwright/test";

const requestedPort = Number(process.env.E2E_PORT ?? 3100);
const port = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort <= 65_535
  ? requestedPort
  : 3100;
const baseURL = process.env.BASE_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.ts",
  webServer: {
    command: `DEV_HUB=off NODE_ENV=test HOMETRUTH_DEVICES=tests/e2e/devices.yml PORT=${port} bun src/index.ts`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
