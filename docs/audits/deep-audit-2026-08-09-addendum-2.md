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

## 5. D16 — downgraded P1 → P2; both the cause and the user impact were wrong

**Filed as:** "abandons 33% of sweeps on its own 700s deadline, leaving `candy_offers.is_active` stale on a public board. Workload growth, not saturation."

⚠ **I first read only the 6 most recent runs (all 32–78s, `deadline_hit:false`) and concluded the deadline diagnosis was simply wrong. That was the same over-generalisation-from-a-calm-window error this audit keeps catching in others.** The 72h picture: 13 runs, 5 fails, `dur_max` **760,223 ms**, 2 deadline hits, 4 degraded sweeps, 99 bidder fetch errors. Sweep B's number was real; my correction was premature. The full 13-run breakdown settles it.

**The discriminator is perfectly bimodal:**

| | healthy (8 runs) | failing (5 runs) |
|---|---|---|
| duration | 38.9–77.9 s | 16.7 s – **760.2 s** |
| `bidder_fetch_errors` | **0** on every one | **24–26** on every one but one |
| `raw_offers_collected` | 7,778–8,596 | `null` or 56–2,011 |

Healthy runs finish **~10× under the 700s budget**, so there is no workload-growth problem. Upstream Magic Eden fetch failures drive retries → long duration → the occasional deadline hit. **Deadline hits are a symptom, not a capacity limit** — raising the budget would only let a broken upstream burn 900s instead of 700s. The fix is bounding/backing off the per-bidder retries.

**The "stale public board" impact does not exist.** Measured: 219 offers, **71 active, every one last seen 4.0h ago**, `active_but_unseen_12h = 0`, 1 expired, 14 active bidders. The guard suppresses deactivation on a degraded sweep, so a failed run is a clean no-op and the next good run refreshes everything. Cost is wasted compute and a red `pipeline_runs` row — not corruption, and not user-visible.

Failures **cluster on 08-07/08-08** — but see the correction below for why, and for what the "clean" tail actually is.

### 5b. ⚠ Corrected against live `pipeline_runs` (2026-08-10, Claude Code) — the 72h window straddles a fix

The 38% figure is measured across a **deploy boundary**, so it describes neither era. Six fixes landed 2026-08-07 (`acb5ff24` → `27609e15`, last deploy ≈ 08-08 03:05Z). Splitting the runs there:

| | pre-fix | post-fix (9 runs, 08-08 03:15Z →) |
|---|---|---|
| max duration | 249s / 710s / **760s** | **78s** |
| deadline hits | 2 | **0** |
| watchdog hangs | 1 | **0** |

**So the duration half of D16 is already fixed**, and "abandons sweeps on its own 700s deadline" / `dur_max 760,223ms` are **pre-fix artifacts that must not be quoted as current**. The remedy §5 proposes — bounding/backing off per-bidder retries — is already shipped.

⚠ **The "minor loose end" (leaky deadline enforcement) is CLOSED, and was never a defect.** The route's own comment documents that exact run: *"On 08-08 00:50Z the watchdog caught the sweep hung in phase `bidder_sweep` with `deadline_hit: false` at 760s."* `deadline_hit:false` was **correct** — the *watchdog* fired, not the deadline, because the sweep was blocked inside an un-timed-out Supabase await, and **a deadline can only fire where the code looks at it**. Fixed by batching mint resolution out of the bidder walk and putting `abortSignal(AbortSignal.timeout(...))` on every remaining DB read.

⚠ **"The last ~24h are clean" is also wrong: `08-09 12:50Z` failed** (`bidder_fetch_errors=24`, degraded). The true residual is **1 of 9 post-fix runs ≈ 11%**, all short (17–32s) degraded sweeps caused by upstream Magic Eden error bursts — not by anything this route controls.

What §5 got **right** and is now confirmed live: the bimodal discriminator (`bidder_fetch_errors` = 0 on every success, 24–26 on every failure), and the zero user impact (re-measured 2026-08-10: 219 offers, 71 active, **all** last seen 4.1h, `active_but_unseen_12h = 0`).

**The new trap this exposes: a failure rate measured across a deploy boundary is meaningless.** §5 correctly widened from 6 runs to 72h to avoid mistaking a calm hour for health — but the wider window then averaged a *fixed* problem together with a *live* one, producing a "38% deadline-driven failure rate" that matched no period. Widening the window is necessary but not sufficient: **split it at every deploy that touched the code.**

---

## 6. D28 — NOT A FINDING. The answer was already written, in this repo, before the audit filed it.

Filed as "the 08-08 v9 split may be mis-classifying." It is not. [`docs/handoff-2026-08-09-atlas-proxy-and-projections-egress.md`](../handoff-2026-08-09-atlas-proxy-and-projections-egress.md) §2 already states it plainly: NBA offseason **and** all three upstreams Akamai/WAF-blocked including the `rpc-sports-proxy` worker the pipeline routes through (DK 403/502, ESPN 403, scoreboard 502). **Even the scoreboard that would prove "no slate" is blocked**, so `all_upstreams_failed` is the literally correct classification, and the handoff concludes "no code fix remains."

⚠ **The method gap this exposes is cheap to close.** Sweep E explicitly disclosed it read only the handoffs *referenced by the recent ledger*, not all 81 — and this one wasn't referenced. **Next pass: grep `docs/handoff-*.md` for each finding's subject before filing it.** One grep would have prevented this finding from existing.

If the permanently-red arm becomes noise, the sanctioned reversible lever is a time-boxed `pipeline_alert_suppression` row expiring 2026-10-14 (operator call — it auto-expires so the alert re-surfaces if projections still can't sync once games return). ⚠ Do **not** retire the pipeline: it is the sole writer for `nba_games`, read by a live public team page.

---

## 7. D20 — the disclosure exists; it is keyed on the wrong field

`set/[slug]/page.tsx:189` already renders a "Variants merged: …" banner — but gated on `set_name_variants.length > 1`, i.e. on merged sets having **different spellings**. The large merges are name-identical seasonal repeats, so they yield one variant and the banner never fires.

**It is anti-correlated with the problem.** Every one of the top 8 AllDay merges has `name_variants = 1`:

| slug | underlying sets | editions |
|---|---|---|
| `draw-it-up` | **10** | 117 |
| `divisional-round` | 8 | 69 |
| `playoff` | 7 | 107 |
| `gridiron` | 7 | 160 |
| `conference-championships` | 7 | 30 |
| `super-wild-card-weekend` | 7 | 73 |
| `against-the-clock` | 6 | 15 |
| `rivalries` | 6 | 16 |

Merging by name is deliberate — `fetchFullTierMix(coll.id, setNames)` queries across variants on purpose so the tier bar isn't sampled from the first 100 editions. So **the fix is not to split the sets**; it is to key the banner on the underlying set count or season span rather than on name variants. Set-completion %, edition count and FMV totals stay on the merged denominator either way.

### 7b. ⚠ Measured (2026-08-10, Claude Code) — the two proposed keys are not interchangeable

§7 offers "underlying set count **or** season span" as if either would do. Measured across all **117** real merges (TS 36 + AllDay 81):

| key | TS merges caught | AllDay merges caught | total | false positives |
|---|---|---|---|---|
| name variants (**current**) | 2 / 36 | **0 / 81** | **2 / 117** | 0 |
| season span (`max_series > min_series`) | 34 / 36 (94%) | **41 / 81 (51%)** | 75 / 117 (64%) | 2 / 148 TS singles |
| underlying set count | — | — | **117 / 117** by construction | 0 |

Two things follow.

**Season span is not sufficient.** It is excellent on Top Shot and a coin-flip on All Day, because All Day's missed half are merges *within a single season* — several same-named sets in one series, which no series comparison can detect. And All Day is the worse-affected collection (81 merges vs 36), so the key performs worst exactly where it matters most.

**But the costs are inverted.** `min_series` / `max_series` are **already columns on `sets_summary`**, so the span key is an RPC + page change touching no MV. A set count is **not** a column, so it needs `refresh_sets_summary()` + the MV + the RPC + the page — four layers on a load-bearing, cron-refreshed MV.

⚠ **So the trap here is shipping the cheap key and calling D20 closed.** That would disclose 64% of merges while reading as handled, and leave half of All Day silently merged behind a banner that now *looks* like it works. Either do the set count properly, or ship span with the residual explicitly recorded — but the one thing not to do is treat "a banner now fires" as "the disclosure is correct."

---

## 8. D25 — two populations, different remedies, neither repaired

128 rows render an impossible serial (0.006% of 2,209,817; 0 lack a matching edition). **TS 71** (9 stale denorm / 62 upstream-wrong) across 20 wallets; **AllDay 57** (25 / 32) across a single wallet.

- **34 stale-denorm rows** — `wmc.mint_count` disagrees with `editions.circulation_count`, which is authoritative (wmc is its cache). These render a visibly wrong fraction and are correctable. ⚠ **`backfill_wmc_metadata_from_editions` will not fix them**: it is `COALESCE` fill-only by design and never overwrites a non-null. That design choice should be checked before overriding it — a value may have been corrected deliberately.
- **94 upstream-wrong rows** — both sources agree the serial exceeds circulation, so the chain data is wrong and there is no local fix.

Not repaired: 34 cosmetic rows is low value against a non-fill-only mutation with no git to record it.

---

## 9. D17 — CLOSED as a measurement artifact. Both halves falsified.

**Filed as:** "4 Vercel cron routes at/over their Lambda ceiling — `allday-lock-refresh` max 310s vs a 300s cap (47.5% fail), `candy-listings-indexer` 344s vs 300," with the inference that "those runs are being killed, so the recorded max is a lower bound."

**(a) The failure rate is a pre-fix artifact** — the same deploy-boundary error as D16, and the overnight handoff had already said so ("the 54.7% 2-day rate is pre-fix runs still inside the window"). Measured over the last 24h:

| pipeline | fails/runs | rate | filed as |
|---|---|---|---|
| `allday-lock-refresh` | 1 / 23 | **4.3%** | 47.5% |
| `candy-listings-indexer` | 0 / 6 | **0%** | — |

**(b) "At/over the ceiling" compares two different clocks.** Both routes really are `maxDuration = 300`. Yet over 72h, **8 of 8 runs exceeding 300s completed with `ok = true` and zero failures** — and `candy-listings-indexer` now *averages* 310s, i.e. its mean run is above the supposed cap while never failing. Both routes use `after()` and return early (`cron/allday-lock-refresh-batch/route.ts:20` — "after() and returns 202 immediately"), so `pipeline_runs.duration_ms` is self-measured across the background continuation and is **not** the interval Vercel's cap enforces.

**Comparing `pipeline_runs.duration_ms` against `export const maxDuration` produces false ceiling alarms. Do not re-file this.**

⚠ **Honest caveat, and it inverts the detector.** This does not prove kills never happen — CLAUDE.md documents that a route killed at `maxDuration` **logs nothing**, so a killed run would be *absent* from `pipeline_runs`, not present with `ok=false`. So long durations are the wrong signal entirely; **the right kill-detector is missing ticks.** Sweep B's own tick-delivery measurement independently clears both routes: 108% and 95% of schedule-implied runs, i.e. no loss.

### 9b. Independently re-verified (2026-08-10, Claude Code) — §9 confirmed, with one precision

Every figure re-measured against live `pipeline_runs` and both route files; all exact:

- `allday-lock-refresh` 24h: **1 / 23 = 4.3%**, and **27** of its 28 failures in the 72h window are older than 24h — confirming the deploy-boundary reading rather than assuming it.
- `candy-listings-indexer` 24h: **0 / 6**, mean **310.1 s** — its *average* run sits above the 300 s cap while never failing.
- Over 72h, **8 runs exceeded 300 s and all 8 are `ok = true`**.
- Both routes confirmed `export const maxDuration = 300`, both compute `duration_ms` **inside** the `after()` continuation.

⚠ **One precision on the mechanism.** The *observation* — over-cap runs succeed — is measured, and it alone is enough to invalidate the comparison. The *explanation* offered in §9 (that `duration_ms` spans an interval the Lambda cap does not enforce) is a reasonable inference but is not proven from Vercel's internals, and Vercel documents `maxDuration` as bounding the whole invocation including `after()`. **Rely on the observation, not the theory** — if someone later shows the cap does bound `after()`, §9's conclusion still holds (the comparison is invalid either way) but its stated reason would need replacing.

Residual worth knowing rather than re-filing: `allday-lock-refresh` averages **271.7 s** against that 300 s cap, but it self-bounds through its own `SOFT_DEADLINE_MS` break (`route.ts:98`) — which is the actual reason it is not killed, and a better thing to preserve than the duration number.

---

## Standing lesson from this pass

Three of this audit's own findings were wrong in the same way: **a claim was made from an aggregate and never checked against the underlying record.** D13 (pipeline "dead" — it was 4.3h fresh), D19 (premise "falsified" — the design was validated), D18 (pipeline "inert" — it writes 233 rows/48h). In each case the aggregate was `pipeline_runs_daily` or a page's rendered number, and the correction came from raw `pipeline_runs.extra` or the base table.

**Before filing any pipeline as dead, inert, or broken: read one raw run's `extra` payload.** It costs one query and it has now overturned five findings (D13, D18, D19, D16, D17).

⚠ **And check that your two numbers measure the same thing before comparing them.** D17 compared `pipeline_runs.duration_ms` against `export const maxDuration` — two different intervals — and manufactured a ceiling breach out of it. The tell was available without any new data: 8 runs "over the cap", 8 successes. **When a threshold is allegedly being exceeded and nothing is failing, doubt the comparison before doubting the system.**

⚠ **Cheaper than any of that: read the code's own comments first.** This repo carries unusually detailed why-comments, and three findings were sitting in one. `SniperFilterBar.tsx:157` cracked D12; `wallet-backfill-helpers.ts:1009` cracked D8; the candy-offers route comment documented the exact 760s run in D16 — and D28's entire answer was in a handoff dated the same day. **Grep the file and `docs/handoff-*.md` for the symptom before measuring it.**

⚠ **But read a WINDOW of runs, not the most recent few.** On D16 I read the 6 latest runs, found them all fast and healthy, and nearly filed "the deadline diagnosis is wrong" — the failures had simply stopped 24h earlier. One query over 72h reversed that. **The `extra` payload tells you the mechanism; only the window tells you the rate.** Both are needed, and quoting one as the other is how a calm hour becomes "this is fine."

⚠ **And then SPLIT the window at every deploy that touched the code** (§5b). Widening from 6 runs to 72h was right, but the wider window straddled the 08-07 fix and averaged a *solved* problem together with a *live* one — yielding a "38% deadline-driven failure rate" that described neither era, and proposing a remedy that had already shipped. The three lessons compose: **`extra` gives the mechanism, the window gives the rate, and the deploy boundary tells you which code the rate is even about.** A rate measured across a fix is not a rate.

⚠ **Cheapest check of all, and it would have caught this one first: read the code's own comments before filing.** The "leaky deadline" loose end was already diagnosed, explained, and fixed *in a comment at the site*. This repo's routes carry unusually detailed why-comments; grepping the file for the symptom is faster than measuring it.
