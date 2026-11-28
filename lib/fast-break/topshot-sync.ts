// lib/fast-break/topshot-sync.ts
//
// The payload a collector's own nbatopshot.com/fastbreak page hands to RPC ("Sync from Top Shot"):
// the run's contest id, every night's objective, and — for tonight — each player card the mode
// lists with its "N of M plays left". Read in the collector's browser by TOPSHOT_READER_SOURCE
// (the bookmarklet / scheduled task), carried to rippackscity.com in the URL fragment, POSTed to
// /api/fast-break/topshot-sync, and written by public.fast_break_ingest_topshot().

import { z } from "zod"

export const SYNC_HASH_PREFIX = "#topshot-sync="

const playerTuple = z.tuple([z.string().min(2).max(80), z.number().int().min(0).max(99).nullable(), z.number().int().min(0).max(99).nullable()])
const playerObject = z.object({
  name: z.string().min(2).max(80),
  left: z.number().int().min(0).max(99).nullable(),
  total: z.number().int().min(0).max(99).nullable(),
})

export const topShotSyncSchema = z.object({
  contest_id: z.string().regex(/^contest-run-nba-(classic|pro)-\d{4}-\d{2}-\d{2}$/, "unrecognised contest id"),
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  nights: z
    .array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), objective: z.string().min(5).max(200) }))
    .min(1)
    .max(30),
  players: z.array(z.union([playerTuple, playerObject])).max(800),
})

export type TopShotSyncPayload = z.infer<typeof topShotSyncSchema>

/** The ingest function's player shape. */
export function normalizePlayers(players: TopShotSyncPayload["players"]): Array<{ name: string; left: number | null; total: number | null }> {
  return players.map(p => (Array.isArray(p) ? { name: p[0], left: p[1], total: p[2] } : p))
}

export function modeOf(contestId: string): "classic" | "pro" {
  return contestId.startsWith("contest-run-nba-pro-") ? "pro" : "classic"
}

/**
 * Runs inside nbatopshot.com/fastbreak?mode=<classic|pro>, signed in. Reads only what the page
 * shows the collector, then sends the tab to RPC's Fast Break page with the payload in the URL
 * FRAGMENT (never sent to any server by the browser; RPC's page reads it and POSTs it to its own
 * API). No tokens, no cross-site requests. Measured against the live page 2026-11-28:
 *   - every night is a date chip; Pro chips carry a set-count badge ("WON Mon, Nov 16 +5");
 *   - clicking a chip sets ?contest=contest-run-nba-<mode>-<runStart>-<nightDate>;
 *   - each player card carries title="N of M plays left" or "Unlimited plays".
 * Returns {error} instead of a partial payload when the page does not look as measured.
 */
export const TOPSHOT_READER_SOURCE = String.raw`(async () => {
  const RPC = "https://www.rippackscity.com/nba-top-shot/fast-break";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (!/nbatopshot\.com$/.test(location.hostname) || !location.pathname.startsWith("/fastbreak")) {
    alert("Open nbatopshot.com/fastbreak (Classic or Pro) first, then run Sync from Top Shot.");
    return JSON.stringify({ error: "wrong_page" });
  }
  const main = () => document.querySelector("main");
  for (let i = 0; i < 20 && !main(); i++) await sleep(500);
  if (!main()) return JSON.stringify({ error: "page_not_loaded" });
  await sleep(2500);
  const norm = (e) => (e.innerText || "").trim().replace(/\n/g, " ");
  const chipRe = /^(WON|LOST|LIVE|OPEN|UPCOMING|MISSED|NO ENTRY)?\s*((Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\w+) (\d+)|Today)(\s*\+\d+)?$/;
  const chips = () => [...main().querySelectorAll("button, a, [role=tab], [role=button]")].filter((e) => chipRe.test(norm(e)));
  const objective = () => (main().innerText.match(/Combine for[^\n]+/) || [null])[0];
  const et = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  const today = et.year + "-" + et.month + "-" + et.day;
  const nights = []; const seenDates = new Set(); let runPrefix = null;
  for (const lab of [...new Set(chips().map(norm))]) {
    const el = chips().filter((e) => norm(e) === lab).pop(); if (!el) continue;
    const before = new URLSearchParams(location.search).get("contest"); el.click(); let c = before;
    for (let w = 0; w < 20; w++) { await sleep(200); c = new URLSearchParams(location.search).get("contest"); if (c && c !== before) break; }
    const m = (c || "").match(/^(contest-run-nba-(classic|pro)-\d{4}-\d{2}-\d{2})-(\d{4}-\d{2}-\d{2})$/);
    if (!m || seenDates.has(m[3])) continue;
    await sleep(900); const o = objective(); if (!o) continue;
    runPrefix = m[1]; seenDates.add(m[3]); nights.push({ date: m[3], objective: o });
  }
  if (!runPrefix) return JSON.stringify({ error: "no_contest_id" });
  nights.sort((a, b) => (a.date < b.date ? -1 : 1));
  const todayChip = chips().find((e) => /Today/.test(norm(e))); if (todayChip) { todayChip.click(); await sleep(2000); }
  const lineupTab = [...main().querySelectorAll("button, [role=tab]")].find((e) => norm(e) === "Lineup"); if (lineupTab) { lineupTab.click(); await sleep(1500); }
  for (let i = 0; i < 40; i++) { main().querySelectorAll("*").forEach((el) => { if (el.scrollHeight > el.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(el).overflowY)) el.scrollTop += 2000; }); window.scrollBy(0, 2000); await sleep(200); }
  const players = []; const seen = new Set();
  for (const t of document.querySelectorAll("[title]")) {
    const v = t.getAttribute("title") || ""; if (!/plays left|Unlimited plays/.test(v)) continue;
    let c = t; for (let k = 0; k < 8 && c && !/next game estimate|GP/.test(c.innerText || ""); k++) c = c.parentElement; if (!c) continue;
    const lines = (c.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
    const name = lines.find((l) => /^[A-Z][A-Za-zÀ-ž'.\-]+( [A-Za-zÀ-ž'.\-]+)+$/.test(l) && !/next game|Season avg|Lineup|Upgrade|Game started/.test(l));
    if (!name || seen.has(name)) continue; seen.add(name);
    const m = v.match(/(\d+) of (\d+)/); players.push([name, m ? Number(m[1]) : null, m ? Number(m[2]) : null]);
  }
  const payload = JSON.stringify({ contest_id: runPrefix, today, nights, players });
  const mode = runPrefix.indexOf("-pro-") > 0 ? "pro" : "classic";
  location.href = RPC + "?mode=" + mode + "#topshot-sync=" + encodeURIComponent(payload);
  return payload;
})()`

/** The same reader as a bookmarklet href. */
export function topShotBookmarklet(): string {
  return "javascript:" + encodeURIComponent(TOPSHOT_READER_SOURCE.replace(/\n\s*/g, " "))
}
