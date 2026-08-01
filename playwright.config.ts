import { defineConfig, devices } from "playwright/test"

// Playwright config for the rendered-DOM live smoke (e2e/smoke.spec.ts) + its
// self-check (e2e/smoke-selfcheck.spec.ts). This is NOT wired into the blocking
// pull_request CI — it is a scheduled monitor against the deployed site
// (.github/workflows/e2e-smoke.yml), mirroring the existing HTTP smoke-tests.yml.
//
// Env knobs (all optional; CI sets SMOKE_BASE_URL, the sandbox sets the rest):
//   SMOKE_BASE_URL   base URL for smoke.spec.ts (default: production)
//   PW_CHROMIUM_PATH executablePath override (the sandbox's pre-installed Chromium)
//   PW_PROXY_SERVER  proxy server + PW_PROXY_BYPASS (sandbox reaches localhost via a
//                    bypass; CI needs neither — it has direct egress)
const baseURL = process.env.SMOKE_BASE_URL || "https://www.rippackscity.com"

export default defineConfig({
  testDir: "e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : 1,
  reporter: [["list"], ["json", { outputFile: "e2e-results.json" }]],
  use: {
    baseURL,
    ignoreHTTPSErrors: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    proxy: process.env.PW_PROXY_SERVER
      ? { server: process.env.PW_PROXY_SERVER, bypass: process.env.PW_PROXY_BYPASS || "localhost,127.0.0.1" }
      : undefined,
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
})
