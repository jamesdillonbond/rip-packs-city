#!/usr/bin/env node
// scripts/qa/mobile-sweep.mjs — the TRUE-MOBILE QA instrument (2026-09-06).
//
// WHY THIS EXISTS. Nothing in the CI gates measures LAYOUT (jsdom boxes are
// zero) and the Cowork/Claude-in-Chrome window cannot resize below ~738 px,
// so "mobile QA" through the extension was a desktop page squinted at. This
// script drives a REAL Chromium at a real phone viewport (Playwright's
// `iPhone 13` descriptor: 390 × 844, DPR 3, touch, mobile UA) against the
// live site, records per-page facts a reviewer cannot get from HTTP 200, and
// writes a screenshot per page that a Cowork session can stage and LOOK at.
//
// It ran 510 entity pages + 32 surfaces × 5 collections on 2026-09-06 from the
// Cowork device VM (Trevor's box) — the recipe that reaches prod when the cloud
// sandbox's proxy resets the TLS tunnel.
//
// USAGE
//   node scripts/qa/mobile-sweep.mjs <paths.txt> <out.jsonl> [shotdir] [mobile|desktop]
//
//   paths.txt   one site path per line (e.g. /nba-top-shot/market)
//   out.jsonl   one JSON record per page, appended
//   shotdir     optional; a PNG per page lands here (put it under
//               _to_delete/qa-shots-<date>/ so the tree stays clean and a Cowork
//               session can stage the PNGs and view them with Read)
//   mode        mobile (default) or desktop (1280 × 900)
//
// ENV
//   RPC_QA_BASE      base URL (default https://www.rippackscity.com)
//   RPC_QA_STATE     a Playwright storageState JSON to run SIGNED IN
//                    (create one by logging in once through a magic link in a
//                    headed/headless context and calling ctx.storageState())
//   RPC_QA_CONC      pages in flight (default 3 — the site's own API budget
//                    starves images above ~4)
//   RPC_QA_SETTLE_MS extra settle before measuring (default 8000; the sweep
//                    already waits 20 s on collection/market/sniper paths)
//   PLAYWRIGHT_BROWSERS_PATH / LD_LIBRARY_PATH as the VM recipe requires.
//
// WHAT A RECORD CARRIES (all measured in the page, none inferred from HTTP):
//   status · ms · iw/sw (sw > iw is a horizontal-overflow defect) · widest
//   (the first element poking past the viewport that no ancestor clips) ·
//   textLen · imgs · broken (complete && naturalWidth === 0, i.e. the browser
//   TRIED and failed — a lazy image that never loaded is NOT counted) · dead
//   ([data-rpc-dead-art] count from DeadImageGuard) · unknown/undef/dollarZero
//   copy counters (each is a HYPOTHESIS — "$0" is legitimate on a market-closed
//   tile) · rows/cards · errCopy (honest-error phrases, so a degraded page is
//   visible without a screenshot) · scanning (stuck on the route-level
//   LoadingState) · console errors · failed (4xx/5xx responses, sentry excluded)
//   · api (every /api/* response the page made) · snippet.
//
// READ THE OUTPUT WITH THE MEASUREMENT RULES: a counter is a hypothesis, the
// screenshot is the evidence; verify a "defect" in a second run before filing —
// a reading taken while the SUBJECT changed (a deploy mid-sweep) is not a
// reading.

import { chromium, devices } from "playwright";
import fs from "node:fs";
import path from "node:path";

const [, , file, out, shotdir, modeArg] = process.argv;
if (!file || !out) {
  console.error("usage: node scripts/qa/mobile-sweep.mjs <paths.txt> <out.jsonl> [shotdir] [mobile|desktop]");
  process.exit(2);
}
const mode = modeArg === "desktop" ? "desktop" : "mobile";
const BASE = (process.env.RPC_QA_BASE || "https://www.rippackscity.com").replace(/\/$/, "");
const CONC = Math.max(1, Number(process.env.RPC_QA_CONC) || 3);
const SETTLE = Math.max(0, Number(process.env.RPC_QA_SETTLE_MS) || 8000);
const paths = fs.readFileSync(file, "utf8").split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
if (shotdir) fs.mkdirSync(shotdir, { recursive: true });

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const ctx = await browser.newContext({
  ...(mode === "mobile" ? devices["iPhone 13"] : { viewport: { width: 1280, height: 900 } }),
  locale: "en-US",
  timezoneId: "America/Los_Angeles",
  ...(process.env.RPC_QA_STATE ? { storageState: process.env.RPC_QA_STATE } : {}),
});

function shotName(p) {
  return `${mode}-${p.replace(/[^a-z0-9]+/gi, "_").slice(0, 70)}.png`;
}

async function one(sitePath) {
  const page = await ctx.newPage();
  const rec = { path: sitePath, mode, console: [], failed: [], api: [] };
  page.on("console", (m) => { if (m.type() === "error") rec.console.push(m.text().slice(0, 140)); });
  page.on("response", (r) => {
    const s = r.status();
    const u = r.url().replace(BASE, "");
    if (s >= 400 && !u.includes("sentry")) rec.failed.push(`${s} ${u.slice(0, 110)}`);
    if (u.startsWith("/api/")) rec.api.push(`${s} ${u.slice(0, 80)}`);
  });
  const t0 = Date.now();
  try {
    const r = await page.goto(BASE + sitePath, { waitUntil: "domcontentloaded", timeout: 60000 });
    rec.status = r ? r.status() : null;
    const heavy = /collection\?|sniper|market/.test(sitePath);
    await page.waitForTimeout(heavy ? Math.max(SETTLE, 20000) : SETTLE);
    for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 1500); await page.waitForTimeout(700); }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);
    const measured = await Promise.race([
      page.evaluate(() => {
        const main = document.querySelector("main") || document.body;
        const t = main.innerText;
        const imgs = [...document.images];
        let widest = null;
        for (const el of document.querySelectorAll("body *")) {
          const b = el.getBoundingClientRect();
          if (b.right > innerWidth + 2 && b.width > 0) {
            let contained = false;
            for (let q = el.parentElement; q; q = q.parentElement) {
              const ox = getComputedStyle(q).overflowX;
              if (ox === "auto" || ox === "scroll" || ox === "hidden" || ox === "clip") { contained = true; break; }
            }
            if (!contained) { widest = { tag: el.tagName, cls: String(el.className || "").slice(0, 60), right: Math.round(b.right) }; break; }
          }
        }
        return {
          iw: innerWidth,
          sw: document.documentElement.scrollWidth,
          widest,
          h1: (document.querySelector("h1") || {}).innerText || null,
          textLen: t.length,
          imgs: imgs.length,
          broken: imgs.filter((i) => i.complete && i.naturalWidth === 0 && i.src && !i.src.startsWith("data:")).map((i) => i.src.slice(0, 80)).slice(0, 3),
          dead: document.querySelectorAll("[data-rpc-dead-art]").length,
          unknown: (t.match(/\bUnknown\b/g) || []).length,
          undef: (t.match(/undefined|NaN|\[object/g) || []).length,
          dollarZero: (t.match(/\$0(\.00)?(?![\d.,])/g) || []).length,
          rows: document.querySelectorAll("table tbody tr").length,
          cards: document.querySelectorAll("[class*=card]").length,
          errCopy: (t.match(/unavailable|couldn.t load|try again|something went wrong|degraded/gi) || []).slice(0, 4),
          scanning: t.includes("SCANNING"),
          snippet: t.replace(/\s+/g, " ").slice(0, 500),
        };
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("evaluate-timeout")), 15000)),
    ]);
    Object.assign(rec, measured);
    if (shotdir) await page.screenshot({ path: path.join(shotdir, shotName(sitePath)) }).catch(() => {});
  } catch (e) {
    rec.err = String(e && e.message ? e.message : e).slice(0, 150);
  }
  rec.ms = Date.now() - t0;
  fs.appendFileSync(out, JSON.stringify(rec) + "\n");
  await page.close();
}

let idx = 0;
await Promise.all(Array.from({ length: CONC }, async () => { while (idx < paths.length) await one(paths[idx++]); }));
await browser.close();

// A one-line tally so a caller can see the shape without opening the JSONL.
const recs = fs.readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const mine = recs.filter((r) => paths.includes(r.path) && r.mode === mode);
const tally = {
  pages: mine.length,
  errored: mine.filter((r) => r.err).length,
  non200: mine.filter((r) => r.status && r.status !== 200).length,
  overflow: mine.filter((r) => r.sw > r.iw).length,
  scanning: mine.filter((r) => r.scanning).length,
  withConsoleErrors: mine.filter((r) => r.console.length).length,
  withBrokenImgs: mine.filter((r) => r.broken && r.broken.length).length,
  withErrCopy: mine.filter((r) => r.errCopy && r.errCopy.length).length,
};
console.log(JSON.stringify(tally));
