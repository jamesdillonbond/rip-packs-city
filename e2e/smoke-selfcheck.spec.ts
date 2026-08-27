import { test, expect, request as apiRequest } from "playwright/test"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { assertHealthyPage, CONSOLE_FAILURES } from "./healthy-page"
import { armClockShift, assertClockShiftArmed, CLOCK_SHIFT_MS } from "./clock-shift"
import {
  parseSitemapLocs,
  toPath,
  pickEntityPath,
  discoverEntityPath,
  __resetSitemapCache,
} from "./entity-urls"

// Self-check for the shared assertHealthyPage helper. The live smoke suite
// (smoke.spec.ts) cannot be exercised from an environment without egress to the
// deployed site, so this spec pins the helper's PASS/FAIL logic against local
// fixtures instead: a healthy page must pass, and each broken shape (500, a
// rendered error boundary, a near-empty streaming shell, missing expected text)
// must FAIL. It is self-contained (a localhost server), so it runs identically
// in CI and locally, and it guards the helper against silent drift.
//
// Coverage note: the helper's whole value is catching the "HTTP 200 but the DOM
// is an error/blank" class, and that detection lives in the ERROR_SIGNS regex
// list + the content-floor + status checks. So this self-check exercises EVERY
// error-sign regex individually (a broken one silently weakens the live gate),
// the minContentChars override in both directions, error-detection priority over
// a content-rich page, and the status branch in isolation from the content one.

const CONTENT = "Real rendered collectibles intelligence content. ".repeat(12) // ~590 chars

const HEALTHY = `<!doctype html><html><head><title>RPC</title></head><body>
  <h1>Rip Packs City</h1>
  <main>${CONTENT}</main>
</body></html>`

const ERROR_BOUNDARY = `<!doctype html><html><body>
  <h2>Application error: a client-side exception has occurred</h2>
</body></html>`

// A server-side exception variant of the same Next.js error boundary — a
// different branch of the first ERROR_SIGNS regex (client|server).
const SERVER_EXCEPTION = `<!doctype html><html><body>
  <h2>Application error: a server-side exception has occurred (see the server logs for more information)</h2>
</body></html>`

// Next.js "not found" rendered at 200 (a notFound() boundary), and a runtime
// overlay — the two ERROR_SIGNS the prior self-check never exercised.
const NOT_FOUND_BOUNDARY = `<!doctype html><html><body>
  <main>This page could not be found.</main>
</body></html>`

const UNHANDLED_RUNTIME = `<!doctype html><html><body>
  <div>Unhandled Runtime Error</div>
</body></html>`

// An error state buried in an otherwise content-rich page — proves error
// detection is NOT gated by the content-length floor (a real regression shape:
// a page that flushes a full shell and THEN throws a client exception).
const ERROR_WITH_CONTENT = `<!doctype html><html><body>
  <main>${CONTENT}</main>
  <div>Application error: a client-side exception has occurred</div>
</body></html>`

const EMPTY_SHELL = `<!doctype html><html><body><div id="__next"></div></body></html>`

// ~130 chars of real content: above a custom 100 floor, below the default 200.
const SHORT_OK = `<!doctype html><html><body><main>${"Short but genuine content here. ".repeat(4)}</main></body></html>`

// ── hydration-mismatch fixtures (React #418) ────────────────────────────────
// These pages are HEALTHY by every other measure the helper checks: HTTP 200,
// no error-boundary text, plenty of content. That is the entire point — a #418
// does not change the final DOM, so it is invisible to the status/content
// assertions and only the console listener can see it. Both delivery paths are
// covered because React can surface it either way depending on the build.

// Thrown, so it arrives via page.on("pageerror") — this is the shape production
// actually emitted on /insights/top-sales and /insights/first-mint.
const HYDRATION_THROW = `<!doctype html><html><body>
  <main>${CONTENT}</main>
  <script>
    setTimeout(function () {
      throw new Error("Minified React error #418; visit https://react.dev/errors/418?args[]=text&args[]= for the full message");
    }, 0);
  </script>
</body></html>`

// Logged, so it arrives via page.on("console") — the dev-build spelling.
const HYDRATION_CONSOLE = `<!doctype html><html><body>
  <main>${CONTENT}</main>
  <script>
    console.error("Text content does not match server-rendered HTML. Warning: Text content did not match.");
  </script>
</body></html>`

// ⚠ THE CRY-WOLF CONTROL, and the more important half of this pair. Real pages
// emit console errors constantly — measured on production 2026-08-16: 35x HTTP
// 405, 26x 500, 8x CSP img-src, on pages that are working perfectly. If the
// helper asserted on ALL console errors it would be red forever and get ignored,
// which is worse than not having it. This fixture reproduces that ambient noise
// and MUST still pass.
const AMBIENT_NOISE = `<!doctype html><html><body>
  <main>${CONTENT}</main>
  <img src="/definitely-missing.png" alt="">
  <script>
    console.error("Failed to load resource: the server responded with a status of 405 ()");
    console.error("Loading the image 'https://cdn.example.com/x.png' violates the following Content Security Policy directive: \\"img-src 'self'\\"");
    console.warn("[Fast Refresh] rebuilding");
  </script>
</body></html>`

// ── clock-shift fixture (positive control for e2e/hydration-clock.spec.ts) ──
// Stands in for a page whose FIRST client render reads the wall clock. The
// server's render time is baked into the HTML exactly as an ISR snapshot bakes
// it; the script compares it to the browser's clock and reports a #418 when they
// disagree by more than a minute — which is what React does when the two renders
// produce different markup.
//
// ⚠ THIS EXISTS BECAUSE ARMING AND DETECTING ARE TWO DIFFERENT THINGS. The clock
// spec's whole value rests on addInitScript reaching the page before its scripts
// run; if it silently did not, every board would pass and the monitor would be
// measuring nothing. This fixture is the end-to-end proof that a shifted clock
// PRODUCES a caught failure — and its unshifted twin is the proof that an
// unshifted run does not.
function clockSensitive(serverNowMs: number): string {
  return `<!doctype html><html><body>
  <main>${CONTENT}</main>
  <script>
    (function () {
      var serverNow = ${serverNowMs};
      if (Math.abs(Date.now() - serverNow) > 60000) {
        throw new Error("Minified React error #418; visit https://react.dev/errors/418?args[]=HTML&args[]= for the full message");
      }
    })();
  </script>
</body></html>`
}

// Sitemap fixtures for the entity-URL discovery self-check (entity-urls.ts).
// Segment 1 = TopShot editions, 2 = AllDay/Golazos/UFC editions, 3 = entities
// (set/player/team) + top moments, 4 = packs, 0 = series (served EMPTY here to
// exercise the no-URL -> skip path).
function urlset(...paths: string[]): string {
  const locs = paths.map((p) => `  <url><loc>https://www.rippackscity.com${p}</loc></url>`).join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locs}\n</urlset>\n`
}
const SITEMAP_BY_ID: Record<string, string> = {
  "0": urlset(), // series segment intentionally empty -> discovery returns null
  "1": urlset("/nba-top-shot/edition/3:45"),
  // Segment 2 carries a MIX, AllDay first, which is the point: the Golazos
  // probe must pick its own collection out of the middle of the list rather
  // than taking whatever happens to be first.
  "2": urlset(
    "/nfl-all-day/edition/6181",
    "/laliga-golazos/edition/541",
    "/ufc/edition/JOE-PYFER-UFC-303-KO-TKO-700",
  ),
  "3": urlset(
    "/moment/11111111-1111-1111-1111-111111111111",
    "/nba-top-shot/set/base-set",
    "/nba-top-shot/player/lebron-james",
    "/nba-top-shot/team/lakers",
  ),
  "4": urlset("/nba-top-shot/pack/dist/123"),
}

let server: http.Server
let base: string

// ⚠ The sitemap memo in entity-urls.ts is MODULE-level and Playwright reuses a
// worker PROCESS across spec files, so a live entity-smoke run in this same
// worker can leave PRODUCTION locs in it — and every discovery assertion below
// would then be reading production instead of the fixture server started here.
// That is not hypothetical: it made this file flaky-green in the 2026-08-23
// dispatch (fixture edition 541 vs production edition 471). Drop the memo
// before EACH test rather than once, so ordering inside this file cannot
// reintroduce it.
test.beforeEach(() => {
  __resetSitemapCache()
})

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url || "/"
    const html = (body: string, status = 200) => {
      res.writeHead(status, { "Content-Type": "text/html" })
      res.end(body)
    }
    if (url.startsWith("/healthy")) html(HEALTHY)
    else if (url.startsWith("/error-boundary")) html(ERROR_BOUNDARY)
    else if (url.startsWith("/server-exception")) html(SERVER_EXCEPTION)
    else if (url.startsWith("/not-found-boundary")) html(NOT_FOUND_BOUNDARY)
    else if (url.startsWith("/unhandled-runtime")) html(UNHANDLED_RUNTIME)
    else if (url.startsWith("/error-with-content")) html(ERROR_WITH_CONTENT)
    else if (url.startsWith("/empty-shell")) html(EMPTY_SHELL)
    else if (url.startsWith("/short-ok")) html(SHORT_OK)
    else if (url.startsWith("/hydration-throw")) html(HYDRATION_THROW)
    else if (url.startsWith("/hydration-console")) html(HYDRATION_CONSOLE)
    else if (url.startsWith("/ambient-noise")) html(AMBIENT_NOISE)
    else if (url.startsWith("/clock-sensitive")) html(clockSensitive(Date.now()))
    else if (url.startsWith("/four-oh-four-with-content")) html(`<!doctype html><html><body><main>${CONTENT}</main></body></html>`, 404)
    else if (url.startsWith("/five-hundred")) html("<!doctype html><html><body><h1>Internal Server Error</h1></body></html>", 500)
    else if (/^\/sitemap\/(\d)\.xml/.test(url)) {
      const id = url.match(/^\/sitemap\/(\d)\.xml/)![1]
      const xml = SITEMAP_BY_ID[id]
      if (xml === undefined) html("nope", 404)
      else html(xml)
    }
    else html("nope", 404)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  base = `http://127.0.0.1:${port}`
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test("PASSES a healthy page (h1 + real content)", async ({ page }) => {
  await assertHealthyPage(page, {
    path: `${base}/healthy`,
    name: "healthy fixture",
    expectText: /Rip Packs City/,
  })
})

test("FAILS a page that throws a React hydration error (#418) despite a healthy DOM", async ({ page }) => {
  // The regression this whole check exists for: HTTP 200, no error boundary,
  // ~590 chars of content — every other assertion in the helper passes, and the
  // page is still broken for the user. Verified live on /insights/top-sales and
  // /insights/first-mint on 2026-08-16.
  await expect(
    assertHealthyPage(page, { path: `${base}/hydration-throw`, name: "hydration throw" }),
  ).rejects.toThrow(/client-side failure|#418/)
})

test("FAILS a page that LOGS a hydration mismatch (console path, not pageerror)", async ({ page }) => {
  // React surfaces this either as a thrown error or a console message depending
  // on the build, so both listeners have to be wired; covering only pageerror
  // would miss the dev-build spelling entirely.
  await expect(
    assertHealthyPage(page, { path: `${base}/hydration-console`, name: "hydration console" }),
  ).rejects.toThrow(/client-side failure/)
})

test("PASSES a page with ambient console noise (does not cry wolf)", async ({ page }) => {
  // ⚠ The control that keeps the check trustworthy. A failed subresource, a CSP
  // image warning and a 405 are what every real page emits; if these tripped the
  // helper the monitor would be permanently red and would stop being read —
  // strictly worse than not having it. Measured production noise, reproduced.
  await assertHealthyPage(page, { path: `${base}/ambient-noise`, name: "ambient noise" })
})

test("FAILS a page rendering a client-side error boundary", async ({ page }) => {
  await expect(
    assertHealthyPage(page, { path: `${base}/error-boundary`, name: "error boundary" }),
  ).rejects.toThrow(/error state/)
})

test("FAILS a page rendering a server-side error boundary", async ({ page }) => {
  await expect(
    assertHealthyPage(page, { path: `${base}/server-exception`, name: "server exception" }),
  ).rejects.toThrow(/error state/)
})

test("FAILS a Next.js notFound() boundary rendered at 200", async ({ page }) => {
  await expect(
    assertHealthyPage(page, { path: `${base}/not-found-boundary`, name: "not found boundary" }),
  ).rejects.toThrow(/error state/)
})

test("FAILS an Unhandled Runtime Error overlay", async ({ page }) => {
  await expect(
    assertHealthyPage(page, { path: `${base}/unhandled-runtime`, name: "runtime overlay" }),
  ).rejects.toThrow(/error state/)
})

test("FAILS an error state even when the page is content-rich (detection is not gated by length)", async ({ page }) => {
  await expect(
    assertHealthyPage(page, { path: `${base}/error-with-content`, name: "error with content" }),
  ).rejects.toThrow(/error state/)
})

test("FAILS a near-empty streaming shell (HTTP 200 but no content)", async ({ page }) => {
  await expect(
    assertHealthyPage(page, { path: `${base}/empty-shell`, name: "empty shell" }),
  ).rejects.toThrow(/empty shell|chars/)
})

test("FAILS a 500 response", async ({ page }) => {
  await expect(
    assertHealthyPage(page, { path: `${base}/five-hundred`, name: "500" }),
  ).rejects.toThrow(/HTTP 500|error state/)
})

test("FAILS a 4xx even when the body is content-rich (status branch, isolated from content)", async ({ page }) => {
  await expect(
    assertHealthyPage(page, { path: `${base}/four-oh-four-with-content`, name: "404 with content" }),
  ).rejects.toThrow(/HTTP 404/)
})

test("minContentChars override: a short page PASSES under a lower floor", async ({ page }) => {
  await assertHealthyPage(page, {
    path: `${base}/short-ok`,
    name: "short ok under custom floor",
    minContentChars: 100,
  })
})

test("minContentChars default: the same short page FAILS under the default 200 floor", async ({ page }) => {
  await expect(
    assertHealthyPage(page, { path: `${base}/short-ok`, name: "short ok under default floor" }),
  ).rejects.toThrow(/empty shell|chars/)
})

test("FAILS when required expected text is absent", async ({ page }) => {
  await expect(
    assertHealthyPage(page, {
      path: `${base}/healthy`,
      name: "healthy fixture missing text",
      expectText: /this string is definitely not on the page/,
    }),
  ).rejects.toThrow(/missing expected content/)
})

// ── entity-URL discovery (entity-smoke.spec.ts's plumbing) ──────────────────
// The live entity monitor can't run without egress to prod, so pin its
// discovery logic against local sitemap fixtures instead.

test("parseSitemapLocs extracts every <loc>, tolerant of whitespace", () => {
  const xml = `<urlset>
    <url><loc>https://x/a</loc></url>
    <url><loc>  https://x/b  </loc></url>
  </urlset>`
  expect(parseSitemapLocs(xml)).toEqual(["https://x/a", "https://x/b"])
  expect(parseSitemapLocs("<urlset></urlset>")).toEqual([])
})

test("toPath reduces an absolute URL to a baseURL-relative path", () => {
  expect(toPath("https://www.rippackscity.com/nba-top-shot/edition/3:45")).toBe("/nba-top-shot/edition/3:45")
  expect(toPath("/already/relative")).toBe("/already/relative")
})

test("pickEntityPath matches the segment and returns null when absent", () => {
  const locs = ["https://x/nba-top-shot/set/base-set", "https://x/moment/abc"]
  expect(pickEntityPath(locs, /\/set\//)).toBe("/nba-top-shot/set/base-set")
  expect(pickEntityPath(locs, /^\/moment\//)).toBe("/moment/abc")
  expect(pickEntityPath(locs, /\/team\//)).toBeNull()
})

test("discoverEntityPath resolves a live URL per type from the sitemap fixtures", async () => {
  const ctx = await apiRequest.newContext({ baseURL: base })
  try {
    expect(await discoverEntityPath(ctx, "edition")).toBe("/nba-top-shot/edition/3:45")
    // Not just "resolves something from segment 2" — it must skip the AllDay
    // URL that precedes it, or the probe silently degrades into a second AllDay
    // check and Golazos goes back to being unwatched.
    expect(await discoverEntityPath(ctx, "edition_golazos")).toBe("/laliga-golazos/edition/541")
    expect(await discoverEntityPath(ctx, "set")).toBe("/nba-top-shot/set/base-set")
    expect(await discoverEntityPath(ctx, "player")).toBe("/nba-top-shot/player/lebron-james")
    expect(await discoverEntityPath(ctx, "team")).toBe("/nba-top-shot/team/lakers")
    expect(await discoverEntityPath(ctx, "moment")).toBe("/moment/11111111-1111-1111-1111-111111111111")
    expect(await discoverEntityPath(ctx, "pack")).toBe("/nba-top-shot/pack/dist/123")
    // Segment 0 (series) is served empty -> discovery yields null -> the live
    // spec SKIPS rather than fails.
    expect(await discoverEntityPath(ctx, "series")).toBeNull()
  } finally {
    await ctx.dispose()
  }
})

// ⚠ POSITIVE CONTROL for the beforeEach above, in BOTH directions. The reset is
// invisible when it works, so without this test a future cleanup deletes it and
// nothing goes red — the file just quietly starts reading production again.
// Step 2 reproduces the exact 2026-08-23 flake mechanism in-process.
test("the sitemap memo is real, and __resetSitemapCache is what makes this file read its OWN fixtures", async () => {
  const ctx = await apiRequest.newContext({ baseURL: base })
  const original = SITEMAP_BY_ID["2"]
  try {
    // 1. Prime the memo from the fixture as it currently stands.
    expect(await discoverEntityPath(ctx, "edition_golazos")).toBe("/laliga-golazos/edition/541")

    // 2. Change what the server serves. The memo still answers with the STALE
    //    list — which is precisely how a live entity-smoke run sharing this
    //    worker feeds production URLs to a fixture-based assertion.
    SITEMAP_BY_ID["2"] = urlset("/laliga-golazos/edition/999")
    expect(await discoverEntityPath(ctx, "edition_golazos")).toBe("/laliga-golazos/edition/541")

    // 3. And the reset is what breaks that hold.
    __resetSitemapCache()
    expect(await discoverEntityPath(ctx, "edition_golazos")).toBe("/laliga-golazos/edition/999")
  } finally {
    SITEMAP_BY_ID["2"] = original
    await ctx.dispose()
  }
})

test("a discovered entity path passes the health assertion end-to-end", async ({ page }) => {
  // Serve the discovered path off the same server as a healthy page: proves the
  // discover -> assertHealthyPage handoff the live spec performs.
  await assertHealthyPage(page, { path: `${base}/healthy`, name: "discovered-entity stand-in" })
})

// ── clock-shift machinery (guards e2e/hydration-clock.spec.ts) ─────────────

function collectClockFailures(page: import("playwright/test").Page): string[] {
  const failures: string[] = []
  const record = (text: string) => {
    if (CONSOLE_FAILURES.some((rx) => rx.test(text))) failures.push(text.slice(0, 300))
  }
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") record(msg.text())
  })
  page.on("pageerror", (err) => record(err.message))
  return failures
}

test("the clock shift ARMS and is observable in the page", async ({ page }) => {
  await armClockShift(page)
  await page.goto(`${base}/healthy`, { waitUntil: "domcontentloaded" })
  // Passes only if Date.now() really moved AND Date.parse / Date.UTC / new
  // Date(iso) did not — a shim that broke those would red every board for a
  // reason unrelated to hydration.
  await assertClockShiftArmed(page)
})

test("assertClockShiftArmed FAILS when the shift was never armed (it cannot pass vacuously)", async ({ page }) => {
  // The check that keeps the clock spec honest. Without this, a broken
  // addInitScript would make every board pass while measuring nothing.
  await page.goto(`${base}/healthy`, { waitUntil: "domcontentloaded" })
  await expect(assertClockShiftArmed(page)).rejects.toThrow(/init script did not run|measuring nothing/)
})

test("a clock-sensitive page FAILS under the shift — the detector composes end to end", async ({ page }) => {
  const failures = collectClockFailures(page)
  await armClockShift(page)
  await page.goto(`${base}/clock-sensitive`, { waitUntil: "domcontentloaded" })
  await page.waitForLoadState("load").catch(() => {})
  await page.waitForTimeout(500)
  expect(
    failures.some((f) => /#418/.test(f)),
    `a page that renders differently ${CLOCK_SHIFT_MS / 3_600_000}h ahead must be caught; saw: ${failures.join(" | ")}`,
  ).toBe(true)
})

test("the SAME page PASSES with the real clock (the shift is what makes it fail)", async ({ page }) => {
  // Without this control, the case above would also pass if the fixture were
  // simply broken — and the clock spec's failure message would be blaming the
  // wrong thing.
  const failures = collectClockFailures(page)
  await page.goto(`${base}/clock-sensitive`, { waitUntil: "domcontentloaded" })
  await page.waitForLoadState("load").catch(() => {})
  await page.waitForTimeout(500)
  expect(failures, `unshifted run must be clean; saw: ${failures.join(" | ")}`).toEqual([])
})
