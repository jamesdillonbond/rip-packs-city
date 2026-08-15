# Handoff — monthly deep audit run 2 (2026-08-15)

Everything below was found by the 2026-08-15 deep audit and **could not be shipped from that session** because the Cowork shell sandbox was down (`useradd` / `/sessions` disk-full class, ~8th occurrence) — so there was no git and no push. DB-side work WAS shipped; see `docs/overnight/ledger.md` 2026-08-15.

Ordered by blast radius. Each item carries what is VERIFIED vs INFERRED, the fix, and the revert.

---

## 1 · P0 — CODE — two overview pages state "No sales in the last 24h" during a DB timeout

**File:** `app/(collections)/[collection]/overview/page.tsx`, lines **331** and **444**.

```
331:  ) : (stats?.sniper_deals?.length ?? 0) === 0 ? (   // renders "No deals ≥15% off right now"
444:  ) : (stats?.top_sales?.length ?? 0) === 0 ? (      // renders "No sales in the last 24h"
```

**VERIFIED.** `/api/collection-stats` correctly returns an honest **503** (`lib/api-error.ts`: *"the database is under heavy load…"*, `code:"timeout"`). The catch leaves `stats === null`. The KPI band correctly renders em-dashes and the page correctly shows *"Couldn't load collection stats right now."* — **the D11 fix works.** But `?? 0` on these two panels turns that same null into a market assertion.

Measured the same minute the pages showed "No sales in the last 24h": **Top Shot 8,332 sales / All Day 240** in the trailing 24 h. The page contradicts itself on screen — its own Insider Signals panel simultaneously listed floor sweeps of 269 and 171 moments from 1–2 h earlier.

This is the **sixth** instance of the honesty-table class in CLAUDE.md, and it is on the very page D11 was fixed on: D11 hardened the KPIs directly above these two panels and did not reach them.

**Fix.** Branch on the error/null state *before* the length check. `stats == null` must render "couldn't load", never "none exist". The two states are different claims — one is about us, one is about the market.

**⚠ Do not stop at these two lines.** The defect is the pattern, not the instance. Sweep the file (and its siblings) for every `?? 0` / `?.length ?? 0` applied to a value that can be null *because a read failed*, and add the guard the honesty table prescribes. A directory-driven test in the style of `__tests__/api-og-insights-empty-vs-unavailable.test.ts` is the right containment — pin it in BOTH directions (a genuinely empty result must still render the empty state, or the fix trades one false claim for another).

**Revert:** `git revert <sha>`. Nothing to unwind.

---

## 2 · P0 — CODE — `/api/edition-floor` lets an UNAUTHENTICATED caller trigger a service-role DELETE on `fmv_snapshots`

**Files:** `proxy.ts:665-673` (the carve-out) and `app/api/edition-floor/route.ts` (lines ~264, ~290, ~273-276, ~313-316).

**VERIFIED.** `proxy.ts` opens `/api/edition-floor` to anonymous `GET|HEAD|POST` under the comment *"Batch read-compute endpoints … stateless reads … **No writes, no user data**"*. That comment is false. Neither `GET` nor `POST` has an auth check, and `?persist=1` (GET) / `{persist:true}` (POST) are **caller-controlled**. Both call `persistFloorToSnapshot`, which builds a `SUPABASE_SERVICE_ROLE_KEY` client and runs:

```
.from("fmv_snapshots").delete().in("edition_id", editionIds).gte("computed_at", todayStart)
```

for up to **50** editions, then re-inserts.

**Worst case (INFERRED, and cheap to confirm):** the re-insert is built from `base = latestByEdition.get(id) ?? {}`, and `fmv_snapshots.confidence` is **NOT NULL** (verified). So on a truncated read (item 3 below) the batch insert fails wholesale *after* the DELETE has committed — today's FMV rows for up to 50 editions destroyed and not restored — inside a `catch` that logs `"persist failed (non-fatal)"`. **Refuted if** the delete and insert share a transaction; they do not appear to.

**Not currently firing:** zero `algo_version = '1.2.1'` rows in 30 days (verified), and the only in-repo caller is `sniper/page.tsx:541`, a single-edition GET with no `persist`. This is a **latent unauthenticated destructive surface**, not an active incident.

**⚠ Why no existing probe caught it:** `check_anon_write_surface()` tests the `anon` **DB role**. This route holds the **service-role key**, so that check is blind to it by construction — the same guard-scope class CLAUDE.md keeps recording.

**Fix.** Gate `persist` on the operator secret in both handlers, or simply delete the `persist` branch (it has no production caller). **Correct the `proxy.ts` comment in the same commit** — a false safety comment is how this survived review.

**Revert:** `git revert <sha>`. Nothing to unwind in the DB.

---

## 3 · P1 — CODE — the public FMV API reports "No FMV data yet" for editions we have priced

**File:** `app/api/fmv/route.ts:58-66`.

**VERIFIED by measurement.** This is the exact D27 anti-pattern the repo has already fixed twice elsewhere: `.from("fmv_snapshots").in("edition_id", internalIds).order("computed_at",{ascending:false})` with **no `.limit()`**, deduped first-wins in JS. PostgREST caps any read at 1000 rows.

Density measured live: **40.7 snapshots/edition** mean (max 209) on Top Shot. On a realistic 100-edition batch (50 freshly-repriced + 50 stale-priced) the query yields 3,702 rows and **the 1000-row window covers 50 of 100**. The other 50 have FMV in the DB and the route returns `{ fmv: 0, confidence: "unknown", error: "No FMV data yet" }` — a false claim about our own coverage, manufactured from a row cap, on the documented product API (`/api/fmv`, anon-reachable via `proxy.ts:666`, plus the public `/api/fmv/demo`).

**The repo already knows the fix and wrote it down twice:** `app/api/alerts/route.ts:64-76` and `app/api/allday-pack-ev/route.ts:315-317` both cite D27 and read **`fmv_current`**. `/api/fmv` was missed.

**Fix.** Repoint to `fmv_current` (DISTINCT ON, 1 row/edition) and chunk the `.in()` at 500 — copy `alerts/route.ts:76-87`; the selected columns all exist on the view. The JS dedup then becomes a harmless no-op. **⚠ Update the `__tests__` fixtures keyed on `fmv_snapshots` in the same commit** — a stale fixture is what nearly kept D27's old shape validated.

Same shape, **P3**, lower stakes: `supabase/functions/scan-ufc-wallet/index.ts:258-265` and `enrich-ufc-wallet/index.ts:175-180` (~1,440 rows vs the cap; UFC's market is closed).

---

## 4 · P1 — INGEST — Pinnacle sales stopped resolving `edition_id` on 2026-08-14, and it is escalating

**VERIFIED, with a clean onset.** Hourly `edition_id IS NULL` rate on `pinnacle_sales`:

| hour (UTC) | sales | nulls | null % |
|---|---|---|---|
| 08-14 ≤15:00 | — | 0 | **0.0%** |
| 08-14 16:00 | 107 | 10 | 9.3% |
| 08-14 22:00 | 85 | 25 | 29.4% |
| 08-15 05:00 | 20 | 15 | 75.0% |
| 08-15 07:00 | 22 | 19 | **86.4%** |

193 nulls in 24 h, and **all 193 of the 30-day nulls fall inside that window** — a regression with a clean onset, not a standing gap, and still worsening at time of writing.

**It has a visible consequence today.** `/disney-pinnacle/overview` renders RECENT TOP SALES as a **blank panel with no empty-state copy at all**: all 5 top sales carry a NULL `edition_id`, so the `LEFT JOIN pinnacle_editions pe ON pe.edition_key = ps.edition_id` cannot match; `get_collection_stats` line ~132 returns 5 rows with null names; the page's empty-state guard (line 444) runs on the **unfiltered** array (length 5, so it is skipped) and the name filter at line 451 then strips all 5.

⚠ **Correction to the sweep that found the blank panel:** it diagnosed the join as *producing* nulls. It is the join's **input** that is null. Chasing the name-join (e.g. via `pinnacle_catalog.legacy_edition_key`) would be wasted work — verified 0 catalog matches too, because there is no key to match on.

**Two fixes, both wanted, independent:**
- **Ingest (root cause):** find why `pinnacle-sales-indexer` stopped resolving `edition_id` on 08-14 ~16:00Z. It is the only lane that regressed; the pipeline itself is green.
- **Page (honesty):** the empty-state guard must run on the **post-filter** array, so an unresolvable set renders an honest message rather than a blank box.

---

## 5 · P1 — OPERATOR (secret) — the D2b register lists are INVERTED

**VERIFIED, in both directions.** Over the full retained `net._http_response` window (6 h, 707 rows): **71 responses are 403, all with body `{"error":"forbidden"}` — the edge functions' own gate rejection. 71 of 71 land on jobid 16's cron minutes; 0 land off them.** Every *other* gate-keyed job is healthy in `pipeline_runs` over 24 h (allday-pack-opens 47+12, topshot-pack-opens-history 93, pinnacle-mints 670+135, pinnacle/golazos pack-ev 4/2).

The register records `backfill-topshot-pack-supply` (cron 15+16) as **"✅ rotated + verified"** and 20/42/44/55/56/83/84 as the failing remainder. **The opposite is true.**

**Blast radius is smaller than P0 implies, and saying so matters:** jobid 16 writes only `pack_drop_pool` `pool_source='gql_historical'`, frozen at 2026-08-12 03:33Z, while the live `gql` lane (118k rows, ~35k refreshed/24 h) is written by the healthy `compute-topshot-pack-ev`. The user-facing pack pool is fine.

**Fix (operator only — the Supabase MCP has no secrets verb):** set `TOPSHOT_PACK_SUPPLY_GATE_KEY_OLD` to the value cron 15/16 already sends — **compare by md5, never echo the value, and do not call `get_edge_function`, which returns the deployed source including the live literal.** Then repoint cron and delete `_OLD`. Deploy needs **both** `--no-verify-jwt` **and** `--import-map supabase/functions/deno.json`.

⚠ **This is service restoration, not rotation.** The value is burned in public git history. "403s stopped" must not close the rotation half of D2b, which remains the real P0.

---

## 6 · P1 — OPERATOR — `compute-pinnacle-pack-ev` 100% failing since 2026-08-11; fix `bd53bb3a` confirmed NEVER DEPLOYED

**VERIFIED, and the discriminator is free.** `bd53bb3a` deliberately made the dedupe counted via `dist_dupe_count` on the `pipeline_runs.extra` payload, so `extra ? 'dist_dupe_count'` settles deploy-vs-ineffective: **false on all recent runs ⇒ never deployed.** Live `extra` is `{"elapsed_ms":1496,"function_version":2}`; error is byte-identical every run — `upsert pack_distributions: ON CONFLICT DO UPDATE command cannot affect row a second time`. Clean 4/4/day 07-30 → 08-10, onset 08-11, 0 ok since 08-12.

**Impact, not previously measured:** `pack_ev_history` for `disney_pinnacle` is frozen at **2026-08-11 06:17:03Z** (the last OK run, to the second) — **~98 h stale**, against TS/AllDay 0.1 h and Golazos 1.5 h. **22 of 81 (27.2%) frozen dists still carry a `+EV` flag**, i.e. a buy signal computed from 4-day-old FMV.

**Fix:** dedup the batch by conflict key (keep last) before upsert, or per-row upsert with a 21000/23505 fallback; verify EV byte-identical to the 08-10 values. Needs `PINNACLE_PACK_EV_GATE_KEY` + an edge deploy (same two mandatory flags as item 5).

---

## 7 · P1 — DB/OPS — `get_collection_stats` still times out; the shipped mitigation is NOT a rescue

Shipped 2026-08-15: `AND computed_at <= now()` on both LATERALs (`Subplans Removed: 1`; that leg **7,763 → 6,220 buffers, −20%**, deterministic).

**⚠ It did not fix the page.** Post-patch, `get_collection_stats('nba-top-shot')` returned correct data in **84 s**; `('nfl-all-day')` still threw `57014`, the trace naming **line 214** — the All Day LATERAL — **with the new predicate visible in the running code** (a free positive control that the migration took).

**The number the next attempt needs:** All Day drives **2,230 LATERAL loops** vs Top Shot's **769** (2.9×), which is why All Day fails first. The remaining cost is a per-edition correlated probe into a 2 GB-instance buffer pool — the `NEXTJS-1Z` thrash mechanism, not a plan defect.

**Real fix (filed, not taken):** stop doing N correlated probes per page view. The precomputed latest-FMV-per-edition materialization already filed in `docs/overnight/inbox/` closes this, the pack-detail item, and the board timeouts together. ⚠ Recorded with its trap: the naive `DISTINCT ON` over `fmv_snapshots` **timed out at 55 s** when tested, so it needs its own plan work.

---

## 8 · P2 — the rest, with pointers

- ✅ **`drain-conflated-subeditions` — ORDERING FIXED (`3a172b6b`), but a SECOND fix is still owed and it is one constant per step.** The reorder (drain before seed + a wall-clock budget guard) is correct and, by the constants (`BUDGET_MS` 600,000 / `TAIL_RESERVE_MS` 8,000 / `STEP_WORST_MS` 121,000 ⇒ a step starts only if elapsed ≤ 471,000), `knots` will be reached at ~261,000 ms with ~210 s of headroom. ⚠ **But `split` and `realign` are themselves 120 s-class rollbacks at `p_limit: 8000`, and the reorder does not help them.** `pipeline_runs_daily` (indefinite) settles it: **07-30 and 07-31 were `ok=1` with 8,177 / 8,140 `rows_written` and all four `split`/`realign`/`knots`/`cataloged` keys present**; nothing at all 08-01→08-09 (the dark era); **08-10→08-14 all four keys NULL, 0 rows.** So the code did not change — **the instance got slower**, and limits that used to fit inside 120 s no longer do. Since the route's own comment (line 228) calls split/realign *"where every user-visible correction actually happens"*, tomorrow's tick should show knots draining while the corrections stay inert. **Fix: drop `split` and `realign` `p_limit` 8000 → ~1000** (the size `catalog` proves fits, at 10.8 s) and walk back up from `step_ms` — exactly the discipline the `knots` comment at lines 277-281 already prescribes, applied downward. One constant per step, no schema, fully reversible. ⚠ Do NOT raise `maxDuration` and do NOT raise the functions' `proconfig` — see the attribution note below. ⚠ `split = 125,250 ms` is **n=1**; tomorrow's payload gives observation 2. **Historical context follows.**
- **(historical) `drain-conflated-subeditions` was 100% dark-killed and nothing watched it.** 5/5 runs 08-10→08-14 fail with `{"phase":"started"}` and `duration_ms` **147–176 ms** — only the start marker lands. Last success 2026-07-31. The D6 fix made it VISIBLE, not working, and raising `maxDuration` 300→600 did **not** help (its own route header at `route.ts:44-51` predicts otherwise and is falsified). It is absent from `pipeline_cadence_watchlist`, and its step 5 `refresh_topshot_conflated_editions_detector_only` is inside the killed tick — **the conflation guard has been stale by construction for ~15 days.** Fix: split the 6 steps so each writes its own row and commits per step (the `reconcile_all_saved_wallet_stats` pattern), **not** another ceiling raise.
- **`candy-listings-indexer` runs and writes but does not log** — `candy_listings.last_seen_at` fresh at 06:40Z while the last `pipeline_runs` row is 08-14 21:35Z. Severity was fixed in-DB this pass; the logging defect is code. ⚠ Do **not** raise `maxDuration` on D17 reasoning — the evidence is the *missing rows*, not the duration.
- **512 canonical Top Shot editions have NO player, and 482 render the SET NAME in the name slot** (3.88%; e.g. `229:7668` "Skyline", `98:3150::6` literally `"Unknown — Clamps"`). Not a coverage gap — all 512 were `updated_at` within 3 days and 311 carry a `description`, so the walk reached them. Consequences: unreachable by player-name search (`player_id` NULL on all 512), and the same moment shows a player in the collection table (wmc-backed) and a set name on the entity page (editions-backed). **357 of 512 are healable** from the modal non-null `wmc.player_name`, COALESCE-fill-only.
- **D8 regenerated 197 → 7,369**, in Top Shot (7,087), not the predicted All Day (208). Only **1,725 (23.4%) are healable defects**; the other 5,567 have no `edition_key` at all — an honest gap at the wmc layer. The tool exists (`rpc_wmc_metadata_selfheal(uuid)`, fill-only, pinned) but automation is still blocked on the operator `CREATE INDEX CONCURRENTLY` in `docs/handoff-2026-08-10-d8-wmc-selfheal-index.md` — **that handoff is now 5 days old and the backlog has grown 37×.**
- **D25's All Day half is now 100% correctable** — 57 stale-denorm, **0** upstream-wrong (was 25/32). Needs a targeted UPDATE with a trailing `w.serial_number <= e.circulation_count` predicate so it cannot touch genuinely-upstream-wrong rows; `backfill_wmc_metadata_from_editions` will never do it (COALESCE fill-only by design).
- **Homepage publishes three serial-premium multipliers the live model does not produce** (`components/HomePageMarketing.tsx:145`): claims 1-of-1 12× / low 4.5× / last-mint 3×; live `serial_fmv_multipliers` says **9.89× / 1.50× / 5.00×**. Two of three wrong in **opposite** directions, so not a stale-refresh artifact. Under a roadmap where accuracy is the gate, this is on the primary acquisition surface. Fix: drop the numerals or render them live with sample size.
- **`openGraph`/`twitter` shallow-merge trap is LIVE in three shared helpers** (`lib/seo.ts` `pageMetadata` ~40 URLs, `buildMeta` the whole entity corpus incl. ~23.5k editions, `collectionLayoutMetadata` 5 roots) plus ~30 of 31 insights layouts missing `twitter.site` — so the public boards the concierge calls "the most shareable thing RPC has" unfurl with **no X byline**. `app/profile/[username]/layout.tsx` is the correct reference implementation and documents the trap in its own header; the fix was never generalised.
- **`/share/<wallet>` renders a failed read as "your wallet isn't indexed yet"** (`page.tsx:60-68`, `98-118`) — an HTTP **self-fetch** returning `null` on any failure, then treated identically to "0 moments". Lowered from P1 only because the client poll re-hits every 8 s so a transient failure self-heals. Also emits **no canonical** (`/share/0xABC` vs `/share/0xabc` are indexable duplicates).
- **`/api/profile/achievements`**: POST is a confused deputy (takes `ownerKey` from the body, calls the edge fn with `INGEST_SECRET_TOKEN`, no `requireOwnedKey`); GET returns `{achievements:[]}` at **200** on a Postgres error — the D11 class, invisible to both leak guards because it swallows the message entirely. ⚠ The GET's *missing ownership check* is **not** a finding: `profile_achievements` carries a deliberate `"public read achievements"` policy (`roles={public}, qual=true`), so the rows are already anon-readable directly.
- **`audit_20260814_editions_player_bio_columns` is in prod with no committed migration file** — a live schema change (the three `player_*` columns) with no git revert path. Recover byte-exact from `schema_migrations.statements[1]` (the D14 precedent — **recover, never retype**). Broader parity: prod **2,544** vs **539** committed files.
- **2 new `function_search_path_mutable` advisor WARNs** on `reconcile_all_saved_wallet_stats` and `rpc_trust_health_precompute_refresh_p` (both from the 08-10 D34 split). Only P2: both are INVOKER procedures with `has_function_privilege` **false** for anon and authenticated, so a mutable `search_path` is style, not exposure. Deliberately not bundled into this pass's migration — `apply_migration` costs a ~10–20 s user-facing `PGRST002` burst and the instance was already saturated.
- **The ledger's `## Queued` section has been dead since 2026-07-01** and contains items the file itself marks RESOLVED elsewhere. A reader following the documented "skim the ledger first" instruction lands on a six-week-stale list. Retitle it as an archive or drain it.
- **`scripts/local-cost-basis-backfill.mjs:137-138`** ships `PASTE_FRESH_COOKIES_HERE` / `PASTE_FRESH_X_ID_TOKEN_HERE` as committed constants — the exact paste-in-place workflow whose leak caused the 2026-08-03 history rewrite. Read from `process.env` instead.

---

## Method notes worth keeping

- **The `pipeline_runs.extra` payload settled almost every pipeline question again**, and split four pipelines that look identical in `rows_written`: `topshot-sales-history-backfill` returns `{"note":"queue_empty"}` in 0.7 s (correct, cheap no-op) while `golazos-`/`ufc-sales-history-backfill` scan 40,000 blocks and decode zero. `compute-laliga-pack-ev` logs `{"phase":"invoked"}` and would read as inert from the rollup alone — but `pack_ev_history` for Golazos is 1.5 h fresh, so it works and only its *row* is blind.
- **A watchlist/suppression justification is a claim with an expiry date.** The `candy-listings-indexer` severity rested on "candy_mlb is unpublished", invalidated by the 07-31 go-live. Two siblings were re-derived; this one was missed. Sweep the class, not the row.
- **Grep before you measure paid for itself again**: `check-migration-parity.mjs` keys on migration NAME, and a version-keyed comparison overstates the 3-day gap by a third (9 → effectively 1 real).
- **A cost estimate is not a measurement, and one warm timing is not a cost.** The leg patched this pass read 5,847 ms then 358 ms on either side of the change; the honest metric is the buffer count.
