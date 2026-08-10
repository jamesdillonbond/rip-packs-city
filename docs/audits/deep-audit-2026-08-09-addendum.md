# Deep audit 2026-08-09 — addendum (follow-up pass on unresolved items)

> **DRAINED 2026-08-09 (Claude Code).** All three items in this addendum are now shipped and moved to RESOLVED in the register: D12 (both halves — the retired `ts_listings` panel AND the `$0.00/0 sales`, which was root-caused as a soft-failed fetch rendering as a measurement), D13 (the Pinnacle FMV fields now come from FMV, `28% / 23d` → `69.4% / 4.7h`; migration `20260810031639`), D19 (CLAUDE.md rate corrected; the `sold_at` design decision re-verified and left alone). **The grain question this addendum flags as the prerequisite was deliberately NOT resolved — it is now D13b.** This file is kept verbatim as the dated investigation record.

---

Continuation of `deep-audit-2026-08-09.md` after Trevor drained 17 findings. **Read-only investigation — nothing shipped.** The Cowork shell is permanently wedged this session (6 consecutive `useradd … /sessions no space` failures), so there is no git, no CI and no deploy; DB reads via Supabase MCP and file reads still work.

Register rows D12, D13 and D19 have been updated in place. Three outcomes, **two of which correct my own original filing.**

---

## 1. D13 — REDIAGNOSED. The original filing was wrong, and the real finding is bigger.

**Filed as:** "Pinnacle FMV 23 days stale; the daily `pinnacle-2.0.0-render` recompute appears dead."

**That is false.** Every Pinnacle pipeline is healthy — measured over 7 days: `pinnacle-fmv-recalc` 13 runs / 0 fails / **27,620 rows**, `pinnacle-listings-indexer` 499 / 2 / **3,806**, `pinnacle-catalog-floor-refresh` 28 / 0 / **63,499**. `pinnacle_fmv_history` is **4.3 hours old** with 25,233 rows written in 7 days.

**The real finding: `get_collection_stats` reads a table that was superseded ~2026-07-17.**

Its Pinnacle arm (`v_is_pinnacle`) reads the legacy `pinnacle_editions` throughout, and — this is the part that matters — derives the **FMV** fields from the **ASK** columns:

```sql
-- prod, get_collection_stats, Pinnacle arm
SELECT COUNT(*) FILTER (WHERE ask_price IS NOT NULL),      -- → fmv_covered
       ROUND(100.0 * … / v_edition_count, 1),              -- → fmv_pct
       NULL::numeric, MAX(ask_updated_at)                  -- → fmv_last_at
INTO   v_fmv_covered, v_fmv_pct, v_fmv_age_minutes, v_fmv_last_at
FROM   pinnacle_editions;
v_fmv_age_minutes := NOW() - v_fmv_last_at;                -- age of an ASK feed, labelled FMV
```

It never touches `pinnacle_fmv_history` or `pinnacle_catalog`. Measured side by side:

| what `/disney-pinnacle/overview` shows | source | reality in `pinnacle_catalog` |
|---|---|---|
| `527` editions | `pinnacle_editions` | **2,457** rows |
| `28%` FMV coverage | `ask_price IS NOT NULL` (328/527) | **95.2%** (2,338/2,457 have `fmv_usd`) |
| `FMV DATA AGE 23D AGO` (red, `PIPELINE STATUS OUTDATED`) | `max(ask_updated_at)` = 2026-07-17 | FMV **4.3h**, `floor_ask` **1.2h** |
| all 5 "cheapest asks" = `$1` | `pinnacle_editions.ask_price ORDER BY ASC` | 23-day-old asks, **140 of 328 are exactly $1** — the documented uniform-$1 Flowty artifact |

So the page **understates our own data quality** and flags itself broken while the data behind it is hours old. It is the pessimistic direction of the same "instrument lies about its own state" class as today's smoke-guard fix.

`pinnacle_catalog` is clearly the intended successor — it carries `floor_ask`, `floor_ask_updated_at`, `fmv_usd`, `fmv_confidence`, `fmv_computed_at`, `fmv_algo_version`.

⚠ **The trap, and why I did not just repoint it.** `pinnacle_editions` is **edition-grain** (527) and `pinnacle_catalog` is **render-grain** (2,457). Swapping `edition_count` 527 → 2,457 would change a public headline number by 4.7× and is exactly the merged-denominator error flagged in D20. **Resolve the grain question first**, then repoint the Pinnacle arm as one coherent change (stats, `sniper_deals`, `top_sales`, `tier_breakdown` all read the legacy table). Unambiguous regardless of grain: `fmv_age_minutes` must come from an FMV timestamp — `max(fmv_computed_at)` in `pinnacle_catalog` and `max(computed_at)` in `pinnacle_fmv_history` agree at 4.3h.

*Re-probe:* `select max(ask_updated_at) from pinnacle_editions;` → currently frozen at 2026-07-17. `select round(extract(epoch from (now()-max(fmv_computed_at)))/60,1) from pinnacle_catalog;` → ~260 min.

---

## 2. D12 — root-caused, and the disclosure banner is the sharper half

`ORDER BOOK DEPTH: 1 listings` comes from **`ts_listings`, which holds exactly 1 row, last written 2026-05-15 (86.5 days ago)** — the table retired with the TS listings-indexer on 2026-05-26. Live Top Shot ask data is in `badge_editions` (**4,541** editions with `low_ask > 0`); `cached_listings_v2` holds **0** Top Shot rows.

⚠ **The codebase already knows this, which changes the fix.** Most surfaces were migrated off it and honestly render an em-dash rather than a fake zero — `edition/[slug]/page.tsx:500` ("*Top Shot's ts_listings feed is dead → render em-dash, not a fake 0%*"), `moment/[id]/page.tsx:1380`, and `SniperFilterBar.tsx:157` which states plainly it "*is a dead table: 1 row, frozen 2026-05-15*".

**`ListingsDashboard.tsx` was missed, and its disclosure now asserts something false:**

```
ts_listings holds a periodically-refreshed sample of the Top Shot marketplace,
typically 100-200 listings of varying tier and price. Not a complete orderbook snapshot.
```

Neither clause is true any more. A visitor reads "periodically-refreshed… typically 100-200" and sees `1`, and concludes the Top Shot market has one listing — not that the feed died three months ago. **A stale disclosure is worse than no disclosure**, because it converts a dead feed into an apparently-live market reading. The app contradicts itself on the same fact in two components.

Cheap fix: retire the panel, or repoint it at `badge_editions` and rewrite the banner. Either way the banner must stop claiming freshness.

⚠ Still unexplained and left open: `TOTAL VOLUME $0.00 / TOTAL SALES 0` for 30d on the same page while Overview reports `$32,584` in 24h.

*Re-probe:* `select count(*), max(ingested_at) from ts_listings;` → 1 row, 2026-05-15.

---

## 3. D19 — my filing was wrong; the design decision is VALIDATED, only the number is stale

**Filed as:** "CLAUDE.md:54's premise is falsified — telemetry says 0 rows for 7 days. Premise is stale either way."

That filing invited simplifying the UFC revival arm. **It should not be simplified.**

⚠ **`pipeline_runs_daily` disagrees with the table, and the table wins.** The rollup reports `rows_written = 0` for both UFC backfills over 7 days. Measured directly against `sales_2026`:

- **485 UFC rows ingested in the last 7 days**, newest ingest `2026-08-05`
- **every one carries `sold_at` ≤ 2026-05-13** (the market-close date)

So historical UFC rows *are* still landing, and an ingest-time predicate would have read those 485 August-ingested rows as a **UFC revival** — precisely the false positive the `sold_at` keying exists to prevent. CLAUDE.md's *rate* ("~200 historical rows/24h") is stale; its *reasoning* is correct and load-bearing.

Two things to carry forward: fix only the number in the comment, and note that **the backfills' `rows_written` telemetry undercounts vs the table** — a separate observability gap that overlaps D32's "finds rows, writes none" cohort and may mean some of those five pipelines are mis-reporting rather than mis-writing.

*Re-probe:* `select count(*), max(ingested_at), max(sold_at) from sales_2026 where collection_id='9b4824a8-736d-4a96-b450-8dcc0c46b023' and ingested_at > now()-interval '7 days';`

---

## Pattern worth naming: "a live surface reads a retired table"

D12 and D13 are the same defect shape, and it now has three instances (counting the `edition_offers` staleness in D21). A retired table does not throw — it returns stale rows or one row, and the surface renders that as current market data. Sweep of write-freshness on the retired-residue candidates:

| table | rows | last write | status |
|---|---|---|---|
| `ts_listings` | 1 | 2026-05-15 (86.5d) | **read live by `ListingsDashboard`** — D12 |
| `pinnacle_editions.ask_*` | 328 asks | 2026-07-17 (23.5d) | **read live by `get_collection_stats`** — D13 |
| `pinnacle_cached_listings` | 141 | 2026-06-08 (62d) | no live reader found (only a 2026-05 migration + two comments confirming it is retired) — clean |
| `flowty_transactions` | 7,734 | 2026-05-24 (78d) | frozen history, documented — not a finding |
| `special_serial_holders` | 25 | 2026-07-05 (35d) | documented legacy; live board is wmc-backed — not a finding |
| `evm_nft_transfers` | 0 | — | documented dead — not a finding |
| `cached_listings` | 304 | **2026-08-10** | alive, fresh |

**Suggested standing probe for future audits** (cheap, catches the whole class): for each table a public surface reads, compare `max(<write timestamp>)` against the surface's implied freshness claim. A table whose newest row predates the last deploy by months, but which is still joined into a rendered KPI, is the signature.

---

## Session status

- **Shell wedged, no git.** All three register edits and this file are written to the working tree **uncommitted** — they need a commit.
- Nothing was applied to prod in this pass. The only prod change from the whole deep audit remains the verified wmc denorm repair (56,898 → 197).
- Register now stands at 24 open, with D12/D13/D19 re-characterised rather than closed.
