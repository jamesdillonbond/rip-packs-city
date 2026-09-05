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

// Console/pageerror text that means the page BROKE, as opposed to the ambient
// noise every real site emits.
//
// ⚠ THE CLASS THIS CATCHES, AND WHY NOTHING ELSE CAN. React #418 is a hydration
// mismatch: the server-rendered text differs from what the client renders on
// hydration. It does NOT change the final DOM (React re-renders client-side),
// so every assertion above this one passes; it is invisible to the API smoke
// gate, and it is unreachable in vitest because that renders both sides in one
// UTC process. A live browser reading the console is the only detector — which
// is why /insights/first-mint threw #418 on every load for an unknown period
// while all three coverage gates stayed green (2026-08-16).
//
// ⚠ DELIBERATELY NARROW. Measured against all 30 public pages on 2026-08-16,
// asserting on ALL console errors would red this monitor permanently: 35x HTTP
// 405, 26x 500, 8x CSP image-src, plus 503/504 on subresources. Those are
// ambient (third-party images, best-effort beacons) and a gate that cries wolf
// gets ignored — this is the only gate that catches the 200-but-broken-DOM
// class, so its signal must stay trustworthy. Add a pattern here only when it
// means the PAGE is broken for a user.
//
// ⚠ WHAT THIS DOES NOT CLAIM — do not read a green run as "no hydration bugs".
// A #418 of this kind is DATA-DEPENDENT: it fires only when a value crosses a
// boundary between the moment the ISR snapshot was rendered and the moment the
// browser hydrates (a UTC day boundary for a date, a 48h window edge for a
// rail). Measured 2026-08-16: a sweep of all 30 public pages caught
// /insights/top-sales throwing #418, and a full run of this suite ~40 minutes
// later passed that same page. So this is BROAD but PROBABILISTIC detection —
// it tells you the class exists somewhere, on some run.
//
// The DETERMINISTIC half lives in unit tests, which run on every CI build:
// render the component with renderToString() at two different wall-clock times
// and assert the markup is identical (see
// __tests__/component-TopSalesBoardClient-hydration-safe.test.tsx), and forbid
// runtime-zone/locale formatting in hydrated insights components (see
// __tests__/insights-client-dates-are-hydration-safe-guard.test.ts). Prevention
// belongs there; this monitor is the net that catches what those cannot model.
export const CONSOLE_FAILURES: RegExp[] = [
  /Minified React error #\d+/i, // any React invariant, incl. #418/#419/#423/#425
  /Hydration failed/i,
  /Text content does not match server-rendered HTML/i,
  /There was an error while hydrating/i,
]

// How long to let the client settle after load before reading the console.
// Hydration errors surface once the bundle executes, which is after the
// `domcontentloaded` the content assertions run against.
const HYDRATION_SETTLE_MS = 1_500

export async function assertHealthyPage(page: Page, check: PageCheck): Promise<void> {
  // Attach BEFORE navigating — a listener added after goto() misses everything
  // the page emitted while loading, which is precisely when hydration runs.
  const consoleFailures: string[] = []
  const record = (text: string) => {
    if (CONSOLE_FAILURES.some((rx) => rx.test(text))) consoleFailures.push(text.slice(0, 300))
  }
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") record(msg.text())
  })
  // An uncaught exception never reaches page.on("console") — React throws #418
  // as a real error, so this listener is the one that actually catches it.
  page.on("pageerror", (err) => record(err.message))

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

  // Give the bundle time to execute and hydrate, THEN read what it logged. This
  // is last on purpose: a page that fails a content assertion should report that
  // clearer failure rather than a console symptom of it.
  await page.waitForLoadState("load").catch(() => {})
  await page.waitForTimeout(HYDRATION_SETTLE_MS)

  // ── DID THE IMAGES ACTUALLY PAINT? ────────────────────────────────────────
  //
  // 🚨 THE CLASS THIS CATCHES, AND WHY NOTHING ELSE COULD. Until 2026-09-04 this
  // file asserted status, body text, console failures and pageerrors — and
  // NOTHING about images. So a page could return 200, log not one error, and
  // still render a grid of blank tiles. Both of the following were live and this
  // monitor was green through both:
  //
  //   * /nba-top-shot/market — **12 of 15** `/api/public/ipfs-media` images
  //     returned 502 and rendered blank (cold-cache misses at the route's 8s
  //     headers budget; an <img> never retries a 502 on its own).
  //   * /insights/top-sales — two Candy MLB cards blank, first because the CSP
  //     refused arweave.net and then, after a same-day "fix", because the avatar
  //     proxy 502'd every redirect from that host.
  //
  // ⚠ SAME-ORIGIN ONLY, and that is the whole design. A third-party CDN blip is
  // not our defect and would make this gate cry wolf — which the header above
  // spends a paragraph explaining we must never do, because this is the only gate
  // that catches the 200-but-broken-DOM class. An image served from OUR origin
  // (`/api/public/ipfs-media`, `/api/public/avatar-media`, `/api/moment-thumbnail`)
  // failing is always ours.
  //
  // ⚠ A RATIO, NOT A BAN, and not because a ban is stricter than we can afford —
  // because a ban would be WRONG. The ipfs-media retry converts a *first-visitor*
  // failure into a second-request success, so one genuinely cold CID at probe
  // time can still leave a single tile blank. That is the system working. What is
  // never working is MOST of them blank: 12 of 15 is a systemic break, 1 of 15 is
  // a cold cache. The threshold is set where those two separate.
  //
  // ⚠ `complete` is load-bearing. A lazy or below-the-fold image has
  // `naturalWidth === 0` simply because it has not loaded, and asserting on it
  // measures the probe's patience rather than the page. Only decided images count.
  const imgStats = await page.evaluate(() => {
    const origin = window.location.origin
    const decided = Array.from(document.querySelectorAll("img")).filter(
      (el) => el.complete && (el.currentSrc || el.src),
    )
    const sameOrigin = decided.filter((el) => (el.currentSrc || el.src).startsWith(origin))
    return {
      total: sameOrigin.length,
      broken: sameOrigin.filter((el) => el.naturalWidth === 0).map((el) => (el.currentSrc || el.src).slice(-70)),
    }
  })

  // Below this many same-origin images the ratio is noise, not a signal.
  const MIN_IMAGES_FOR_RATIO = 4
  if (imgStats.total >= MIN_IMAGES_FOR_RATIO) {
    const brokenRatio = imgStats.broken.length / imgStats.total
    expect(
      brokenRatio,
      `${check.path}: ${imgStats.broken.length} of ${imgStats.total} SAME-ORIGIN images decided but ` +
        `painted nothing (naturalWidth 0) — the page returned 200 and logged no error, which is ` +
        `exactly how 12-of-15 blank Moment tiles went unnoticed on /nba-top-shot/market. These are ` +
        `our own endpoints, so an upstream blip is not an explanation. Examples: ` +
        `${imgStats.broken.slice(0, 3).join(" | ")}`,
    ).toBeLessThanOrEqual(0.5)
  }

  expect(
    consoleFailures,
    `${check.path} logged a client-side failure (hydration mismatch or React invariant). ` +
      `React #418 means the server HTML and the hydrated DOM disagree — usually a render that ` +
      `reads the wall clock or the runtime timezone. Messages: ${consoleFailures.join(" | ")}`,
  ).toEqual([])
}
