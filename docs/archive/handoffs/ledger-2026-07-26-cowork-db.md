# Ledger entry — 2026-07-26 Cowork session (DB-only changes)

Paste into `docs/overnight/ledger.md` and add the one-line summary to `CLAUDE.md` → Recent sessions.
**No repo code was changed by this session** — the paired code changes shipped separately as `373b8c3b` (handoff items 1–4) and `93d03601` (item 5). Everything below was applied live via the Supabase MCP.

## 2026-07-26 · Cowork · 14 migrations, all live and verified

Handoff of record: `docs/handoff-2026-07-26-db-saturation-and-allday-resolver.md` (v6).
Cost model: `docs/dune-budget-analysis-2026-07-26.md`.

### Read-path performance

| migration | effect | revert |
|---|---|---|
| `audit_20260726_get_edition_offers_union_all` | `OR` → `UNION ALL`; every call had been scanning all 22,374 open offers, including for editions with none. **22,729 → 1,033 buffers, 8.3 ms.** Output verified identical on 70/70 editions (49 non-empty). Surface carries 51.4% of collection page views. | re-apply prior body (single scan with the `OR`) |
| `audit_20260726_get_pack_lifecycle_row_perf` | `UNION` → `UNION ALL` + carry columns through instead of re-joining `pack_rips` by PK. Was 17,608 ms / 222,494 buffers with `written=12,835` — a read-only RPC evicting dirty buffers and taxing the whole instance. Equivalence proven structurally (disjoint branches; `topshot_pack_rip_attribution` PK on `rip_id`, 37,323 = 37,323 distinct). | re-apply prior body |
| `audit_20260726_get_pack_market_row_mv_swap` | Reads `mv_pack_ev_latest` instead of the `pack_ev_latest` view. **632.7 ms → 43.3 ms, 320,975 → 1,207 buffers.** Output byte-identical on 5 dists (3 TS, 2 AllDay). Two-token splice of the live definition, guarded to exactly 2 matches. | `FROM mv_pack_ev_latest pel` → `FROM pack_ev_latest pel` (2 sites) |

### Security

| migration | effect | revert |
|---|---|---|
| `audit_20260726_revoke_anon_refresh_seeded_wallet_stats` | Revoked anon/authenticated EXECUTE. **Incomplete — see next row.** | `GRANT EXECUTE ... TO anon, authenticated` |
| `audit_20260726_revoke_public_refresh_seeded_wallet_stats` | The first revoke did nothing: a `PUBLIC` grant sat underneath and anon is a member of PUBLIC. Now `postgres, service_role` only, re-verified via `has_function_privilege`. The function is SECURITY INVOKER but calls SECDEF `holdings_summary()` **first**, so an anon POST could burn up to 21 s of DB time. No `check_*` covers this shape. | `GRANT EXECUTE ... TO PUBLIC` |

### Alerting — fixed the instruments, not the data

| migration | effect | revert |
|---|---|---|
| `audit_20260726_pipeline_alerts_unmapped_backlog_arm` | Wired `check_unmapped_backlog_growth()` into `get_pipeline_alerts()`. It had existed since 07-25 with **zero consumers** and returned `high` the first time it was called. Spliced via `pg_get_functiondef()` + `replace()`. | delete the arm between the `pgcron-startup-timeout` line and the closing paren |
| `audit_20260726_unmapped_backlog_growth_actionable_denominator` | Adds `open_actionable_rows`, `open_gross_unsplittable_rows`, `inflow_24h_fresh`, `inflow_24h_backfill`; severity now keys on actionable rows vs **fresh** inflow. The old alert counted 20,295 permanently-unresolvable rows in its denominator and a deliberate backfill as live traffic (only 205 of 4,751 were sold in 7 days). Against live sales the resolver runs a **5.2× surplus**. Dropped `high` → `info`. | re-apply prior body |
| `audit_20260726_unmapped_backlog_growth_perf_two_pass` | Perf correction to the above, caught by timing it **after** applying: the window-function form ran **25 s** against `get_pipeline_alerts()`'s 45 s `statement_timeout` and would have risked timing out every other alert arm. Two-pass form is **4.3 s**; the new dimension costs 75 ms, the rest is the scan the original always had. | re-apply prior body |
| `audit_20260726_pipeline_alerts_unmapped_detail_honest` | Rewrote the alert detail. The old text asserted "the resolver is not keeping up", which the data does not support. | re-splice prior detail expression |

### Sentinel data layer (paired route change shipped by Claude Code as `93d03601`)

| migration | effect | revert |
|---|---|---|
| `audit_20260726_sentinel_fmv_confidence_canonical_ts_split` | New RPC returning `(printing, confidence, count)`. Base 9,347 @ 24.7% HIGH+MED vs parallels 3,610 @ 9.8% — the combined 20.5% was falling **because parallel cataloguing is succeeding**. Sums agree with the existing fn by construction. Old fn left intact so the route kept working until the code landed. | `DROP FUNCTION public.sentinel_fmv_confidence_canonical_ts_split();` |
| `audit_20260726_sentinel_edition_coverage_live` | New RPC excluding the 6,556 inert UUID-keyed TS rows from the coverage denominator (24% of it). 99.25% reported → **99.64%** live. ⚠ Scopes the inert test to Top Shot: `external_id LIKE '%-%'` is **not** a global proxy — UFC is 518/518 dashed and Candy 125/125, all legitimate slugs; global use misclassifies 643 real editions. | `DROP FUNCTION public.sentinel_edition_coverage();` |

### Dune budget

| migration | effect | revert |
|---|---|---|
| `audit_20260726_park_sales_seller_recovery_dune_lane` | Sets `sales_seller_recovery_state.cursor_end` to `floor_date`, so `route.ts:134` breaks `drained=true` **before** any Dune call — a zero-datapoint no-op. Gives the next billing cycle wholly to the ingest lane, which is a superset (creates rows *and* fills counterparties; ~1,495 useful writes/window vs ~365). **Verified live 21:47:40Z: `ok:true, drained:true, windows_done:0, error NULL`**, against 402s at 19:47 and 20:47. | `UPDATE public.sales_seller_recovery_state SET cursor_end='2025-10-24', updated_at=now() WHERE id=1;` |
| `audit_20260726_sales_counterparty_recovered_source_column` | Adds nullable `source`. Three writers shared this table untagged, which is why per-lane productivity was unmeasurable and a false "fills 0 rows" claim survived three sessions. **Inert until the writers populate it; NULL means UNATTRIBUTED, not "no lane".** Catalog-only on 444,094 rows. | `ALTER TABLE public.sales_counterparty_recovered DROP COLUMN source;` |
| `audit_20260726_comment_mv_pack_ev_latest_unguarded` | `COMMENT ON MATERIALIZED VIEW` recording that `mv_pack_ev_latest` lacks **both** the sentinel CASE and the troll-ask publish guard that `pack_ev_latest` carries. The troll-ask guard is in the view's `WHERE`, so it changes *which* row `DISTINCT ON` selects and **cannot be re-applied downstream**. | `COMMENT ON MATERIALIZED VIEW public.mv_pack_ev_latest IS NULL;` |

## Do not do these

- **No `sales` index change.** The `sales_2026_transaction_hash_unique_idx` widening recommended earlier is **retracted**: `multi_nft_tx_total_unsplittable` is not an index rejection — `decodeV1SaleTx` returns one gross DUC total per tx and the route skips those *on purpose*. Real collision: **32 rows**, and widening wouldn't fix even those (partition-local, duplicating the stricter `idx_sales_tx_hash (transaction_hash, sold_at)` present on every partition; all 6,715 multi-row txs share one `sold_at`).
- **Do not swap `get_pack_realized_ev_row` to the MV.** It reads `gross_ev`, which the MV publishes unguarded. The sound version is a new MV built from the view's full definition including its `WHERE`.
- **Do not touch `sales_ingest_state.cursor_end`** (currently `2022-01-01`) — poised exactly on the 0.0%-coverage era.
- **Do not lower `sentinel_threshold_config.warn_at`** for FMV Confidence. Base at 24.7% vs a threshold of 25 still warns, and that is now meaningful.

## Closing state

20/20 trust-health metrics ok · 0 security-invariant breaches · 0 SECDEF anon-exec violations or drift · 0 stalled pipelines · **0 pageable alerts** (3 `info`) · 0 pg_cron failures in 2h · 939 pipeline runs in the last hour with 7 failures (0.75%, down from ~26% of failure volume being the two Dune lanes).
