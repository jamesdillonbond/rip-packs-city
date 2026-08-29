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
  // ⚠ The `html` reporter is LOAD-BEARING, not a nicety. e2e-smoke.yml uploads
  // `playwright-report/` on failure, and nothing was writing that directory —
  // every failing run ended with `No files were found with the provided path:
  // playwright-report/`. This is the repo's ONLY client-side detection surface
  // (Sentry has dropped every event since 08-18, #34), so a failure that keeps
  // no evidence is a red badge nobody can act on. Measured on run 111
  // (2026-08-26): a REAL React #418 hydration failure on
  // /insights/underpriced-serials, through two retries, 0 bytes retained.
  // `open: "never"` so a local failing run does not try to spawn a browser.
  reporter: [
    ["list"],
    ["json", { outputFile: "e2e-results.json" }],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    baseURL,
    ignoreHTTPSErrors: true,

    // ⚠ A NON-UTC TIMEZONE IS LOAD-BEARING, not cosmetic.
    //
    // React #418 (hydration text mismatch) is the one user-visible defect class
    // no other gate here can see: vitest renders "server" and "client" in one
    // Node process, and CI runners are UTC — so a page whose SSR output depends
    // on the runtime zone renders IDENTICALLY on both sides and the mismatch is
    // unreachable *by construction*. That is exactly how /insights/first-mint
    // shipped a #418 that only a live browser in a real timezone could produce
    // (2026-08-16: a sale at 00:00Z rendered "Aug 16" server-side and "Aug 15"
    // to a Pacific visitor).
    //
    // Pinning America/Los_Angeles makes this monitor render in a zone that
    // DISAGREES with the UTC server, so the console assertion in
    // e2e/healthy-page.ts can actually observe the class. Pinning the locale too
    // keeps number/date formatting deterministic run-to-run. Override with
    // PW_TIMEZONE if a future zone is more representative — but do NOT set it to
    // UTC, which silently disarms the check.
    timezoneId: process.env.PW_TIMEZONE || "America/Los_Angeles",
    locale: "en-US",
    // Retries are already on in CI; a trace on the first retry costs nothing on
    // a green run and is the whole diagnostic payload on a red one.
    trace: "on-first-retry",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    proxy: process.env.PW_PROXY_SERVER
      ? { server: process.env.PW_PROXY_SERVER, bypass: process.env.PW_PROXY_BYPASS || "localhost,127.0.0.1" }
      : undefined,
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
})
