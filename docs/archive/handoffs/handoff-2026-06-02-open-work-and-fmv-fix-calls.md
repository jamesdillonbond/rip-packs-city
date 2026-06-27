# Open work + handoff — 2026-06-02 (Cowork audit + FMV pass)

Consolidated punch-list after the interactive Cowork pass. Coordinates with the parallel Stream A–D workflow — don't double-ship.

## Shipped LIVE + verified this session (DB only; Cowork can't push code)
- **P1** `audit_20260602_evm_transfers_watchlist_threshold_150m` — `evm-transfers-ingest` stall watchlist 60→150m (kills the hourly false-positive). Revert in migration comment.
- **S1** `audit_20260602_revoke_anon_v_moments_needing_hydration` — REVOKE anon/authenticated on that SECDEF view. Revert: `GRANT SELECT ON public.v_moments_needing_hydration TO anon, authenticated`.
- **`audit_20260602_v_fmv_sanity_flags_peer_relative`** — new monitoring view `public.v_fmv_sanity_flags` (TS editions priced < 12% of their on-chain set's median, set median > $200, set ≥ 5 editions). 2 flags at install: `8:62` Giannis Cosmic ($1.56 vs $801), `74:2650` Magic Johnson Anthology ($28 vs $315). security_invoker, service_role only. Revert: `DROP VIEW IF EXISTS public.v_fmv_sanity_flags`.
- Docs committed + pushed: platform-audit, packs handoff, FMV/LiveToken audit, rpc-fmv-audit skill (`07d8114`, `23d51a4`, `f1d7b5b`).

## N2 — `v_moments_needing_hydration` timeout (CORRECTED diagnosis)
`EXPLAIN` shows a **Hash Anti Join** (cost ~53.8K): the MATERIALIZED `cand` CTE = 333K `pack_pull`/`verified` acquisitions, anti-joined to 260K `moments` via `c.nft_id = (m.nft_id)::text AND c.collection_id = m.collection_id`.
- **NOT a missing-index problem.** A hash anti-join will not use a btree/expression index — I verified, so the earlier "add an expression index on `moments((nft_id::text), collection_id)`" idea is **withdrawn** (it would be a no-op).
- It only times out at cron-rush concurrency (connection-pool + `statement_timeout` pressure), 3/138 runs, self-recovering.
- Fix options (operator/CC), pick one: **(a)** bump `statement_timeout` on the hydrator's candidate-read call (lowest-risk; route code). **(b)** shrink the candidate set — add `AND acquired_date > now() - interval '60 days'` to the `cand` CTE (old un-hydrated pack-pulls are likely permanently un-hydratable; `CREATE OR REPLACE VIEW`, keep `security_invoker=on` per S1, keep the MATERIALIZED CTE). **Do NOT revert the 2026-06-01 materialized-CTE fix** (net-positive).

## FMV recalc-fix product calls (recommendations for the Stream C decisions)
1. **STALE in portfolio totals:** exclude from the headline total, show as a footnote ("+ $X across N stale-priced moments"). Including a $949 stale Wemby inflates the total; excluding entirely hides real value — footnote is the honest middle.
2. **JSON-LD price on STALE moments:** omit `offers.price` for STALE (don't let Google index an unreliable price); keep availability + name. A wrong indexed price is worse than none.
3. **60d vs 90d lookback (NO_DATA low-circ fix):** 90d (or 120d). Low-circ grails (KD Supernova circ 10; LeBron Anthology circ 99) trade too rarely for 60d — the cross-check showed exactly these as NO_DATA. Tag the recovered prices SALES_ONLY/STALE.
4. **ASK discount → haircut layer:** yes, consolidate. ASK_ONLY realizes ~0.75 via the downstream haircut, so a write-time ask×0.90 double-discounts/conflicts. Write ASK_ONLY at the raw ask and let the single liquidity-aware haircut apply the discount.

## Sales→edition mis-mapping (the 2 `v_fmv_sanity_flags` editions)
`8:62` Giannis Cosmic ($1.56, 39 recorded sales in 120d all <$10) and `74:2650` Magic Johnson Anthology ($28). Determine whether the cheap sales are mis-keyed `nft_id`s (attributed to the wrong `edition_id`) or genuine wash trades. If mis-keyed → re-map those sales; if wash → add a wash/low-outlier filter to recalc's sales input. **Do NOT live-patch the FMV** (clobber risk + it's pricing logic); fix the sales attribution upstream. `v_fmv_sanity_flags` will catch any new occurrence automatically.

## Wire the guard into monitoring (cheap, recommended)
Add to `rpc-weekly-health-check` (or the daytime monitor): `SELECT * FROM v_fmv_sanity_flags;` and alert if any row appears. Ongoing regression guard for premium-set mispricing.

## Other open handoffs
- **Q8** — badge-sync `onConflict:id` vs `UNIQUE(external_id,collection_id)` (badge data quality only; offers decoupled to `edition_offers`).
- **Remaining FMV LiveToken wallets (8 of 10)** — confirmatory; run the `rpc-fmv-audit` skill in a browser session. The 34–38K-moment whales (alxo, Rigged) need a **paginated** pull (page through `portfolio.moments`, ~145 pages, with waits) — the one-shot FMV_DESC capture freezes the renderer on them.
