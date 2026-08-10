# Deep audit 2026-08-09 — addendum 2 (second follow-up pass)

Read-only investigation after the addendum-1 items were drained at `088d6276`. **Nothing shipped** — the Cowork shell is still wedged (no git, no CI, no deploy). Register rows D3b, D11, D18, D32 updated in place.

Four outcomes. **Two of them correct claims made earlier in this same audit** — one of which would have caused real damage if actioned.

---

## 1. D11 — ROOT-CAUSED, and it affects all 5 collections, not just AllDay

My previous message guessed D11 shared a root with D12's `$0.00 / 0 sales`. **That guess was wrong**, and the real mechanism is more specific and easier to fix.

`app/api/collection-stats/route.ts:76-87` — when `get_collection_stats` errors (statement timeout under saturation), the route returns:

```ts
if (error) {
  return NextResponse.json({ error: "stats_unavailable" }, { status: 200 })   // ← 200, not 5xx
}
```

The consumer's only guard is `if (!res.ok) throw` (`overview/page.tsx:214`). **200 is ok**, so it never throws; `setStats({error:"stats_unavailable"})` runs; `stats` is now a **truthy object**; and every field falls through its `?? 0`:

```tsx
:268  value={stats ? (stats.edition_count ?? 0).toLocaleString() : null}   // → "0"
```

`catch` never fires, so no error banner either. Result: `TOTAL EDITIONS 0 / PRICED 0% / $0 / PIPELINE UNKNOWN` — a database timeout rendered as "this collection has no editions."

⚠ **The page already handles this correctly when `stats` is null** — the `: null` branch renders an em-dash, which is why `FMV —` appeared alongside the false `0`s in the same screenshot. The 200-with-error-body is the *only* thing defeating an otherwise-correct design, so the fix is a `data.error` check before `setStats`, not a rewrite.

Because the guard is in the shared route, **any collection whose stats RPC times out shows this.** AllDay was simply the one that timed out during the sweep.

*Re-probe:* `curl -s '…/api/collection-stats?collection=nfl-all-day' | head -c 80` — a body starting `{"error":"stats_unavailable"}` served with HTTP 200 is the bug.

---

## 2. D18 — ⚠ the headline example was FALSE, and acting on it would have deleted a working pipeline

I recorded `pinnacle-sales-history-backfill` as inert and called it "the cheapest saturation win available" (p95 237s × 62 ticks for 0 rows). **It is not inert.**

Measured direct from `pipeline_runs`: **233 rows found and 233 written in 48h**; the latest run shows `rows_written = 131` with an `extra` payload describing a live block scan (`"scanned":"143932740-143972739"`, `"pinnacleIn":131`, `"below_floor":false`). Even the rollup's own 7-day view reports **64** written, not 0.

Retiring it would have been the `pinnacle-sync` deletion again, one step upstream — and note the register entry already carried a warning about not retiring 0-row schedules, aimed at the wrong hazard (auth). The actual hazard was that **the 0-row claim itself was never verified against raw telemetry.**

Confirmed genuinely 0/0 in *both* raw and rollup over 48h, so these entries stand: `golazos-`, `ufc-`, `topshot-sales-history-backfill`. **Every remaining entry on that list needs the same raw re-check before anyone touches it.**

⚠ Secondary, and worth not over-reading: `pipeline_runs_daily` is written `11 */6`, so it lags raw by up to 6h. A raw-vs-rollup gap on a recent window is **lag, not corruption** — I nearly filed that as a telemetry defect and it isn't one.

---

## 3. D32 — all 5 resolved; "finds rows, writes none" is not a defect signature

The `extra` payload is decisive in every case, and the five split into four different situations:

| pipeline | `extra` says | verdict |
|---|---|---|
| `topshot-onchain-art-backfill` | `scanned:60, thumbs_filled:0, videos_filled:0, resolver_misses:60, terminated_reason:"no_more_editions"` — identical every run | ⚠ **A green pipeline that accomplishes nothing.** 100% resolver-miss, `ok=true`, 8×/day, indefinitely. Actively failing and reporting success |
| `topshot-subedition-circulation-backfill` | — | **Finished work.** Only **53 of 3,694** subeditions still lack `circulation_count`; the 22,020 "found" is re-enumeration. A drain nobody turned off — the *opposite* of the above, so do not apply one remedy to both |
| `pack-events-ingest-backfill` | `caught_up:true`, `from_block == to_block` | Idle by design. Not a defect |
| `pinnacle-listings-retry` | `cadence_resolved:6, resolved:2, still_unresolved:4` | It **is** resolving; `rows_written` just doesn't count resolutions. Telemetry label, not a defect |
| `match-topshot-players` | `auto_aliased:0, total_unresolved:1251, needs_review_count:1233` | Review-queue generator — writing 0 is correct. ⚠ But it reports `candidate_count:0` / `best_sim:0.13` for names as common as **LaMelo Ball**, so the *matcher* may be broken, and 1,233 players sit in a queue nobody reviews |

Also worth recording: the 6,598 Top Shot editions with a NULL thumbnail are ~entirely the known **6,561 UUID-keyed non-canonical residue** (an honest gap), not the art backfill's failure.

**Method that cracked all five: read `pipeline_runs.extra`, not the rows_found/rows_written pair.** The aggregate columns cannot distinguish "caught up", "finished", "resolving but not counting", and "failing 100% silently" — the payload distinguishes all four instantly.

---

## 4. D3b — definitive list produced, and the obvious rewrite has a trap

Live `pg_proc` scan found **13** functions still carrying a `lower(<alias>.wallet_address)` predicate:

`get_wallet_portfolio(text)` **×3** · `update_fully_enriched_flags(numeric)` ×3 · `mcp_find_set_completion(text,text,text)` ×2 · `analytics_resolve_usernames(text[])` · `backfill_pinnacle_mint_acquisitions(int)` · `discover_and_seed_active_wallets(int,int,bool)` · `get_active_challenges(text,uuid)` · `get_challenge_plan(text,uuid)` · `get_user_profile(text)` · `holdings_summary(text)` · `pick_verification_target(text,int)` · `sync_seeded_wallet_to_username_cache()` · `tg_capture_topshot_insider_marketplace_buyback()`

⚠ **The natural rewrite `lower(col) = lower(param)` → `col = lower(param)` silently breaks Candy.** Case audit across every wallet-bearing table:

| table | rows | non-lowercase |
|---|---|---|
| `wallet_moments_cache` | 2,211,030 | **25,375** (all Candy — Solana base58 is case-sensitive by design) |
| `seeded_wallets` | 274 | 0 |
| `saved_wallets` | 99 | 0 |
| `wallet_usernames` | 8,388 | 0 |

So on **wmc**, forcing the parameter lowercase makes every Candy wallet match zero rows — a silent, single-collection regression that would ship green. Only `col = param` (exact) is safe there. On the other three tables the column is provably all-lowercase, so dropping `lower()` is unconditionally equivalence-preserving.

This is why each function needs its own equivalence check rather than a bulk find-and-replace: **the safe rewrite differs by which table the predicate targets.** `holdings_summary` is additionally DB-pinned — its `supabase/tests/` copy must move in the same commit.

---

## Standing lesson from this pass

Three of this audit's own findings were wrong in the same way: **a claim was made from an aggregate and never checked against the underlying record.** D13 (pipeline "dead" — it was 4.3h fresh), D19 (premise "falsified" — the design was validated), D18 (pipeline "inert" — it writes 233 rows/48h). In each case the aggregate was `pipeline_runs_daily` or a page's rendered number, and the correction came from raw `pipeline_runs.extra` or the base table.

**Before filing any pipeline as dead, inert, or broken: read one raw run's `extra` payload.** It costs one query and it has now overturned three findings.
