# A COLD ISR regeneration can exceed the 8 s board budget and bake the failure into 15 minutes of cached HTML — and `pack-drops` has no stale snapshot to fall back to

**Filed:** 2026-08-24 14:41Z (07:41 PT) · **By:** Claude Opus 5, Claude Code on Trevor's Windows box · **Status:** OPEN, measured, **not fixed** — the remedies are design choices, not a bug fix.

⭐ **Found by a fix, not by a search.** Minutes after deploying the fifth-layer honesty fix (`34d8ff78`), `/insights/pack-drops` rendered **"Pack drops couldn't be loaded — refresh to try again."** in production. Before that deploy the same state rendered as **"No live re-pack drops to score right now. Check back when the next Vaultopolis drop lists."** — so **this degradation was already happening and was invisible, disguised as a quiet market.** ➡ **An honesty fix's first job is to make the real problem findable, and it did that within minutes.**

## ⚠ MY FIRST HYPOTHESIS WAS WRONG, OFF ONE SAMPLE

The API route reported `elapsed_ms: 11529` on the first call. **8 s is `BOARD_LIVE_TIMEOUT_MS`**, so the tidy conclusion was *"the read always exceeds the budget, so this page is permanently degraded."* **That is false.** Five more samples:

| sample | elapsed_ms |
|---|---|
| 1 (first, cold) | **11,529** |
| 2 | 4,286 |
| 3 | 1,140 |
| 4 | 1,187 |
| 5 | 1,293 |
| 6 | 1,192 |

**Warm, the read is ~1.2 s — six times under budget.** The 11.5 s was a **COLD** path. ➡ **A directional claim needs a distribution, not a snapshot** — the one-instant read would have sent someone to "raise the timeout" for a query that is fine 5 times out of 6.

## What is actually true

1. **The read is normally ~1.2 s and occasionally ~11.5 s cold.** `source: vaultopolis_public_api + rpc_fmv` — it calls an EXTERNAL API, so the cold cost is upstream, not the DB.
2. **A cold regeneration that exceeds 8 s fails the page's read**, and `export const revalidate = 900` then **serves that failure for up to 15 minutes.** Observed live: `x-vercel-cache: HIT`, `age: 158`, degraded copy, while the API answered in 1.2 s throughout.
3. 🚨 **`pack-drops` HAS NO STALE SNAPSHOT.** `BOARD_LIVE_TIMEOUT_MS`'s own comment justifies the budget as *"precisely when a stale-but-complete snapshot is the better answer"* — but the page calls `fetchBoardForPage("Pack drops", [], …)`, i.e. **the fallback is `[]`.** The budget's stated rationale does not hold for this caller. **Check which other boards pass an empty fallback rather than a snapshot before touching the constant.**
4. **The blast radius is the page's whole purpose.** `pack-drops/page.tsx` exists to put the scored drops into the **raw server HTML so the unique content is crawlable — the SEO thesis.** A cold-miss window serves a crawler a page with no drops on it.

## ⛔ NOT FIXED, AND WHY

Every remedy is a design decision, and three of them are wrong in ways worth naming:

- ⛔ **"Raise `BOARD_LIVE_TIMEOUT_MS`"** — it is **shared by every insights board**, and it was created deliberately (first-mint, 2026-08-12) so a throttled DB falls back rather than blocking a page or a build. Raising it globally to fix one board's cold upstream call trades every board's worst case for this board's rare one.
- ⛔ **"Just retry"** — the abandoned query **keeps running server-side** (supabase-js has no cancel; the module says so). A retry adds load during the exact window the budget exists to protect.
- ⛔ **"Lower `revalidate`"** — that increases how often the cold path is hit, not how often it succeeds.
- ✅ **The two plausible ones:** give this page a **per-caller budget** (the precedent exists — `SET_DETAIL_TIMEOUT_MS` on `/analytics/sets`), and/or **give it a real stale snapshot** so its fallback matches the rationale the shared budget is written against. **Both want Trevor's call on which.**

## Re-derive before acting

⚠ **Every number here is a dated sample.** Re-run the six-sample distribution before quoting ~1.2 s, and **confirm the page is still degraded** — it should self-heal on the first warm revalidation, which makes this **intermittent and easy to declare fixed by accident.** The honest test is not "is the page OK now" but **"does a cold regeneration still exceed 8 s"**.
