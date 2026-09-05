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

  // ── WAIT FOR THE PAGE TO ACTUALLY RENDER BEFORE READING IT ────────────────
  //
  // 🚨 THIS WAIT USED TO COME *AFTER* THE CONTENT ASSERTIONS, AND THAT MADE THEM
  // FIRE ON PAGES THAT WERE PERFECTLY HEALTHY. `goto` above uses
  // `waitUntil: "domcontentloaded"`, which for a streaming App Router route fires
  // when the SHELL has parsed — the content is still arriving. Reading the body
  // at that instant measures how fast the server flushed, not whether the page
  // works, and a user never sees that state because a user waits.
  //
  // ⭐ REPRODUCED, not theorised. `/moment/0632adf8-…` read at exactly the old
  // moment, three times:
  //
  //     chars@DCL = 2061   chars@settle = 2061
  //     chars@DCL =   25   chars@settle = 2061   <-- the smoke failed here
  //     chars@DCL = 2061   chars@settle = 2061
  //
  // **25 is the same number the failing run reported**, and the content was
  // there 1.5 s later. Same cause for the sibling flake: the Golazos edition
  // page's Dapper CTA is present in 575 of 575 rows and rendered 9/9 when the
  // read waited, so `missing expected content` was the read arriving early.
  //
  // ⚠ WHY IT TOOK 37 PROBES TO FIND: every earlier probe waited for `load` plus a
  // settle before reading — differing from the harness in the ONE dimension that
  // decides the answer. That is this repo's own rule about a probe whose harness
  // differs from production, applied to an investigation of the harness itself.
  //
  // ⛔ THIS IS NOT A LOOSENING. A page that never fills still fails: the floor,
  // the error-sign scan and `expectText` are unchanged, and the fixtures pin both
  // directions. What changed is WHEN we look — after the page has rendered
  // instead of before.
  await page.waitForLoadState("load").catch(() => {})
  await page.waitForTimeout(HYDRATION_SETTLE_MS)

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
    `${check.path} rendered only ${bodyText.trim().length} chars (likely an empty shell) — ` +
      `read after load + ${HYDRATION_SETTLE_MS}ms, so this is not a streaming race`,
  ).toBeGreaterThanOrEqual(floor)

  if (check.expectText) {
    expect(
      check.expectText.test(bodyText),
      `${check.path} is missing expected content ${check.expectText}`,
    ).toBe(true)
  }

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
    // Images served by OUR OWN media proxies. Always page CONTENT, never chrome.
    const MEDIA_ROUTES = ["/api/public/ipfs-media", "/api/public/avatar-media", "/api/moment-thumbnail"]
    const proxied = sameOrigin.filter((el) => MEDIA_ROUTES.some((r) => (el.currentSrc || el.src).includes(r)))
    // Images from a THIRD-PARTY host, grouped BY HOST. Most of this site's art
    // is served straight from a CSP-allowed CDN, so it is invisible to both
    // checks above — see the comment on the assertion below.
    const byHost: Record<string, { total: number; blank: number; sample: string }> = {}
    for (const el of decided) {
      const src = el.currentSrc || el.src
      let host = ""
      try {
        host = new URL(src, window.location.href).host
      } catch {
        continue
      }
      if (host === window.location.host) continue
      byHost[host] = byHost[host] || { total: 0, blank: 0, sample: "" }
      byHost[host].total += 1
      if (el.naturalWidth === 0) {
        byHost[host].blank += 1
        if (!byHost[host].sample) byHost[host].sample = src.slice(-70)
      }
    }
    return {
      total: sameOrigin.length,
      broken: sameOrigin.filter((el) => el.naturalWidth === 0).map((el) => (el.currentSrc || el.src).slice(-70)),
      proxied: proxied.length,
      proxiedBroken: proxied
        .filter((el) => el.naturalWidth === 0)
        .map((el) => (el.currentSrc || el.src).slice(-70)),
      byHost,
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

  // ── AND A SECOND CHECK, BECAUSE THE RATIO ABOVE IS STRUCTURALLY BLIND TO A
  //    THIN PAGE — WHICH IS WHERE THE NEXT BREAKAGE ACTUALLY HAPPENED ────────
  //
  // 🚨 THE RATIO MISSED A REAL SITE-WIDE OUTAGE, and this is the repair. On
  // 2026-09-05 every UFC Strike image on the site was broken (403 from the media
  // proxy, 518 thumbnails + 516 videos) and it was found by a hand-run sweep, not
  // by this file. Two independent reasons the check above could not see it:
  //
  //   1. It needs >= 4 same-origin images, and a UFC edition page has THREE.
  //   2. Most content art on this site is NOT same-origin — it is served from
  //      assets.nbatopshot.com and friends, which the CSP allows directly — so a
  //      page's same-origin set is mostly CHROME. Measured across 19 public
  //      surfaces: page-chrome dilutes the ratio badly enough that a page's ONLY
  //      artwork can break while the ratio reads 33%.
  //
  // ⭐ THE DISCRIMINATOR IS THE ROUTE, NOT THE COUNT. An image served by our own
  // media proxy is always CONTENT — nobody proxies a logo through
  // /api/public/ipfs-media. So this check scopes to those routes and can afford
  // to be strict where the diluted ratio cannot.
  //
  // ⚠ THE THRESHOLD IS "ALL OF THEM", AND IT IS MEASURED RATHER THAN CHOSEN.
  // Across those 19 surfaces the proxy-image counts are 1, 1, 3 and 17 — so a
  // >= 4 floor would miss three of the four pages that carry any at all. With two
  // or more independent CIDs, all-blank is never a cold-cache story. With exactly
  // one, all-blank means the page's only artwork is missing, which is a broken
  // page for that visitor whatever the cause.
  //
  // ⚠ Calibrated against production before shipping: at the time of writing,
  // 0 of 19 surfaces had even ONE blank proxy image, so this fires on breakage
  // rather than on the steady state. A gate that cries wolf is one people learn
  // to ignore, and this file is the only client-side detection surface there is.
  if (imgStats.proxied > 0) {
    expect(
      imgStats.proxiedBroken.length,
      `${check.path}: ALL ${imgStats.proxied} image(s) served by our own media proxy ` +
        `decided and painted nothing (naturalWidth 0). These are our endpoints, so an ` +
        `upstream blip is not an explanation, and with more than one CID it cannot be a ` +
        `cold cache either. This is the check that would have caught the 2026-09-05 UFC ` +
        `outage, which the same-origin ratio missed because an edition page carries only ` +
        `three same-origin images and most of them are chrome. Broken: ` +
        `${imgStats.proxiedBroken.slice(0, 3).join(" | ")}`,
    ).toBeLessThan(imgStats.proxied)
  }

  // ── AND A THIRD ARM: A CDN HOST WHOSE ART IS MOSTLY GONE ──────────────────
  //
  // 🚨 THE TWO CHECKS ABOVE SHARE A BLIND SPOT AND A COLLEAGUE FOUND IT THE SAME
  // NIGHT THEY SHIPPED. `/nfl-all-day/set/genesis` renders **47 of 52 images
  // blank** — the whole Genesis set (352 editions, every one an ULTIMATE 1/1) has
  // no art at its upstream — and it passes BOTH: the ratio arm because those
  // images are not same-origin, and the proxy arm because none of them are proxy
  // URLs. **A page can be 90% blank and green.**
  //
  // ⚠ THIS IS DELIBERATELY *NOT* A REFLEXIVE WIDENING, and the distinction is a
  // measurement rather than an intention. Across 13 pages and ~400 third-party
  // images, every healthy host reads **0% blank** — `assets.nbatopshot.com` 0/114
  // and 0/44, `media.nflallday.com` 0/31, 0/29 and 0/105,
  // `assets.laligagolazos.com` 0/31, `arweave.net` 0/3 — while the broken one
  // reads **15 of 19 (79%)**. Healthy and broken are separated by the whole range,
  // so a 50% threshold is nowhere near either population.
  //
  // ⚠ PER HOST, NOT PER PAGE. Pooling would let a page with 114 good Top Shot
  // images hide 19 dead All Day ones — which is exactly the shape here, since
  // `/insights/trophies` serves both hosts at once.
  //
  // ⛔ "A third-party CDN blip is not our defect" is TRUE AND NOT THE POINT. A
  // transient blip does not take out MOST of one host's images on a page; and
  // when it does, the page is visibly broken to the reader whoever's fault it is.
  // This gate answers "is the page broken", not "is it our fault" — the fault
  // question decides what to DO about it, not whether to notice.
  const MIN_HOST_IMAGES = 4
  for (const [host, st] of Object.entries(imgStats.byHost)) {
    if (st.total < MIN_HOST_IMAGES) continue
    expect(
      st.blank / st.total,
      `${check.path}: ${st.blank} of ${st.total} images from ${host} decided and painted ` +
        `nothing. Healthy CDN hosts on this site measure 0% blank; the one measured ` +
        `failure was 79% (the NFL All Day Genesis set, whose art is gone upstream). ` +
        `A blip does not take out most of one host's images — if this is upstream, the ` +
        `page is still broken for the reader. Example: ${st.sample}`,
    ).toBeLessThanOrEqual(0.5)
  }

  expect(
    consoleFailures,
    `${check.path} logged a client-side failure (hydration mismatch or React invariant). ` +
      `React #418 means the server HTML and the hydrated DOM disagree — usually a render that ` +
      `reads the wall clock or the runtime timezone. Messages: ${consoleFailures.join(" | ")}`,
  ).toEqual([])
}
