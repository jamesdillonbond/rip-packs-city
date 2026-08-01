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

const HEALTHY = `<!doctype html><html><head><title>RPC</title></head><body>
  <h1>Rip Packs City</h1>
  <main>${"Real rendered collectibles intelligence content. ".repeat(12)}</main>
</body></html>`

const ERROR_BOUNDARY = `<!doctype html><html><body>
  <h2>Application error: a client-side exception has occurred</h2>
</body></html>`

const EMPTY_SHELL = `<!doctype html><html><body><div id="__next"></div></body></html>`

let server: http.Server
let base: string

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url || "/"
    if (url.startsWith("/healthy")) {
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(HEALTHY)
    } else if (url.startsWith("/error-boundary")) {
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(ERROR_BOUNDARY)
    } else if (url.startsWith("/empty-shell")) {
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(EMPTY_SHELL)
    } else if (url.startsWith("/five-hundred")) {
      res.writeHead(500, { "Content-Type": "text/html" })
      res.end("<!doctype html><html><body><h1>Internal Server Error</h1></body></html>")
    } else {
      res.writeHead(404)
      res.end("nope")
    }
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

test("FAILS a page rendering an error boundary", async ({ page }) => {
  await expect(
    assertHealthyPage(page, { path: `${base}/error-boundary`, name: "error boundary" }),
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

test("FAILS when required expected text is absent", async ({ page }) => {
  await expect(
    assertHealthyPage(page, {
      path: `${base}/healthy`,
      name: "healthy fixture missing text",
      expectText: /this string is definitely not on the page/,
    }),
  ).rejects.toThrow(/missing expected content/)
})
