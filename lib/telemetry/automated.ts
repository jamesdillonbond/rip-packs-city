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
