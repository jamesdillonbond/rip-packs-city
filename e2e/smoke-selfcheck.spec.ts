import { test, expect } from "playwright/test"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { assertHealthyPage } from "./healthy-page"

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

let server: http.Server
let base: string

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
    else if (url.startsWith("/four-oh-four-with-content")) html(`<!doctype html><html><body><main>${CONTENT}</main></body></html>`, 404)
    else if (url.startsWith("/five-hundred")) html("<!doctype html><html><body><h1>Internal Server Error</h1></body></html>", 500)
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
