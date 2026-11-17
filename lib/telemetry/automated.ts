// lib/telemetry/automated.ts
//
// ⚠ HUMAN vs AUTOMATED (2026-09-29). Signed-out beacons carry no visitor id, so
// before this tag a scraping browser and a collector were the same "anon" row.
// Measured that day: ~320 anon page-views per /insights page in 48 h, in bursts
// every few minutes around the clock, while Vercel Web Analytics (which filters
// bots) saw ~20 page-views an hour; every anon client_error in the prior 14 days
// but two came from `Lightpanda/1.0`, a headless scraping browser.
// 🔁 CORRECTED the same evening from `automated_by`: the flood is MOSTLY OUR OWN
// E2E DOM smoke (Playwright, run after every production deploy, dozens a day) —
// 110 of the first 118 tagged rows; Lightpanda was 8. So a beacon
// from a known automated user agent — or one whose page reported
// navigator.webdriver — is WRITTEN with `automated: true`, not dropped: the rows
// stay countable, and a human count filters on the tag. The client's own
// `automated` key is always overwritten, so a page cannot claim to be human.
const AUTOMATED_UA =
  /lightpanda|headlesschrome|phantomjs|playwright|puppeteer|selenium|webdriver|lighthouse|pagespeed|chrome-lighthouse|(?<!cu)bot\b|bot\/|crawler|spider|slurp|curl\/|wget\/|python-requests|python-urllib|axios\/|node-fetch|undici|go-http-client|okhttp|java\//i

export function isAutomatedUserAgent(ua: string | null | undefined): boolean {
  return automatedReason(ua) !== null
}

// WHICH rule matched, stored beside the tag (`automated_by`) so an over-match is
// auditable from the rows: 09-29's first check could see that real visitors got
// through untagged, but not whether any were caught — no UA is stored.
export function automatedReason(ua: string | null | undefined): string | null {
  if (!ua) return "no-ua" // a real browser always sends one
  const m = AUTOMATED_UA.exec(ua)
  return m ? m[0].toLowerCase() : null
}

// 2026-10-31: a spoofed-UA headless driver still betrays itself when ITS injected
// script throws — the stack frame reads `eval at evaluate (` (Puppeteer/Playwright
// `page.evaluate`). 8 /insights/first-mint client_errors on 10-28 alternated an
// iPhone and a Mac UA inside one minute, every stack through `evaluate`, all blocked
// by our CSP (no unsafe-eval). Our bundle never calls eval, so this frame cannot
// come from RPC code.
const DRIVER_STACK = /\beval at evaluate \(/

export function automatedStackReason(stack: unknown): string | null {
  return typeof stack === "string" && DRIVER_STACK.test(stack) ? "page-evaluate" : null
}

// 2026-11-09 (weekend activity review): OUR OWN sweeps — the post-deploy E2E DOM
// smoke and the hourly QA runs — wrote 21,943 of the weekend's 22,548 page-view
// rows (Playwright 21,239 · headless Chrome 704). Those page views are COUNTED per
// hour (public.automated_pageview_hourly) instead of stored as rows. Only these two
// matches, and only page views: a third-party scraper (Lightpanda, crawlers, HTTP
// clients) and any automated client_error are still written as tagged rows, which
// is what the 09-29 tag above exists to keep visible.
const COUNT_ONLY = new Set(["playwright", "headlesschrome"])

export function countOnlyAutomatedPageView(feature: string, automatedBy: string | null): boolean {
  return feature === "page-view" && automatedBy != null && COUNT_ONLY.has(automatedBy)
}
