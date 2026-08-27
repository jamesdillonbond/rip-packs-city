// panini-cdp-preflight.mjs — is the debug Chrome on PANINI_CDP_URL actually USABLE?
//
// Exit 0 = a real Playwright CDP session was established (and closed again).
// Exit 1 = it was not. The launcher (scripts/panini-run.bat) treats 1 as
//          "kill the panini-profile Chrome and relaunch it".
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// On 2026-08-27 `RPC Panini Ingest` had been exiting 1 for ~22 h — four missed
// 4-hourly bursts — while `panini-ingest` sat 1,343 min silent against a 360 min
// watchlist ceiling, and /insights/panini-squeeze (PUBLIC since 2026-08-01) drifted.
//
// The cause was a HUNG Chrome, and the reason it never self-healed is the shape
// worth remembering: `panini-run.bat` relaunched Chrome only when port 9222 was
// not listening —
//
//     $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',9222)
//
// A hung browser still ACCEPTS TCP. So the guard passed, Chrome was never
// restarted, and every run died on `connectOverCDP: Timeout 30000ms exceeded`.
//
// 🚨 AND THE OBVIOUS FIX IS ALSO WRONG — measured, not assumed. The natural
// upgrade is "probe the CDP HTTP endpoint instead of the raw socket". Against
// the actually-hung browser, `GET /json/version` returned **HTTP 200** with a
// full version payload. It would have passed too. The browser was serving the
// HTTP arm of the debug port while being unable to complete a CDP session.
//
// ⭐ So the only honest check is the one that does WHAT THE CONSUMER DOES:
// `connectOverCDP`, the same call the runner makes. This repo already has the
// rule — *a control must use the PRODUCTION CALLER*, and *probe THE ENDPOINT YOU
// NEED, not any endpoint it should reach*. A liveness probe that exercises a
// different code path than the consumer is testing something nobody depends on.
//
// ⚠ Deliberately SHORTER than the runner's own 30 s connect timeout: the point
// is to fail fast and hand the launcher time to restart, not to wait as long as
// the thing we are pre-empting.

import { chromium } from "playwright"

const CDP = process.env.PANINI_CDP_URL || "http://localhost:9222"
const TIMEOUT_MS = Number(process.env.PANINI_CDP_PREFLIGHT_TIMEOUT_MS || 15000)

let browser = null
try {
  browser = await chromium.connectOverCDP(CDP, { timeout: TIMEOUT_MS })
  // Connecting is necessary but not sufficient — a browser that hands back no
  // context is not one the runner can drive either.
  const contexts = browser.contexts()
  if (!contexts.length) {
    console.error(`[panini-preflight] connected to ${CDP} but it exposes NO browser context`)
    process.exit(1)
  }
  console.log(`[panini-preflight] OK — CDP session established (${contexts.length} context(s))`)
  process.exit(0)
} catch (e) {
  console.error(`[panini-preflight] UNUSABLE: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
} finally {
  // Never let a close error decide the exit code.
  try {
    await browser?.close()
  } catch {
    /* ignore */
  }
}
