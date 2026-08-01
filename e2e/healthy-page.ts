import { expect, type Page } from "playwright/test"

// Shared rendered-DOM health assertion for the live-smoke suite.
//
// WHY THIS EXISTS: the API smoke gate (/api/smoke-test + scripts/smoke-gate.py)
// checks JSON from a route, never the rendered page. But this app streams — a
// broken page still returns HTTP 200 with an empty shell (the recurring
// "200 but blank/broken DOM" incident class: blank hero, double-h1, a route
// that 500s only after the shell flushes). This assertion reads the RENDERED
// body, so those slip through 200 checks but not this one.

export type PageCheck = {
  path: string // absolute URL, or a path resolved against SMOKE_BASE_URL
  name: string
  expectText?: RegExp // page-specific content that must render
  minContentChars?: number // override the "not a blank shell" floor
}

// Substrings that mean the page rendered an error/crash state rather than content.
const ERROR_SIGNS: RegExp[] = [
  /Application error: a (?:client|server)-side exception/i,
  /Internal Server Error/i,
  /This page could not be found/i,
  /Unhandled Runtime Error/i,
]

const DEFAULT_MIN_CONTENT = 200

export async function assertHealthyPage(page: Page, check: PageCheck): Promise<void> {
  const resp = await page.goto(check.path, { waitUntil: "domcontentloaded" })
  expect(resp, `no HTTP response for ${check.path}`).toBeTruthy()

  const status = resp!.status()
  expect(status, `${check.path} returned HTTP ${status}`).toBeLessThan(400)

  const bodyText = (await page.locator("body").innerText().catch(() => "")) || ""

  for (const sign of ERROR_SIGNS) {
    expect(
      sign.test(bodyText),
      `${check.path} rendered an error state matching ${sign}`,
    ).toBe(false)
  }

  // A streaming shell with no content still returns 200 — require real text.
  const floor = check.minContentChars ?? DEFAULT_MIN_CONTENT
  expect(
    bodyText.trim().length,
    `${check.path} rendered only ${bodyText.trim().length} chars (likely an empty shell)`,
  ).toBeGreaterThanOrEqual(floor)

  if (check.expectText) {
    expect(
      check.expectText.test(bodyText),
      `${check.path} is missing expected content ${check.expectText}`,
    ).toBe(true)
  }
}
