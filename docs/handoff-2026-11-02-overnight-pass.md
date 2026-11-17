# RPC overnight pass — 2026-11-02 (Pacific)

**Run:** `rpc-nightly-overnight`, Cowork cloud (laptop-VM clone + `.rpc-git-cred`). RUNID `cowork-20261102T090357Z-27917`.
**Mode:** genuine overnight. Fired 09:03Z = **1:03 AM PT**, inside 00:00–06:00 → normal shipping allowed. Clock verified no-skew (shell `date -u` 09:03Z == DB `now()` 09:03:26Z == newest `sales.ingested_at` 09:03:07Z). Push AVAILABLE (dry-run authenticated, Everything up-to-date). Not frozen. Lock taken fresh (last entry RELEASED from the 11-01 pass).
**Verdict:** 🟢 GREEN. **0 shipped, 0 reverted.** One docs commit (this handoff + ledger + metrics + session). Nothing was both low-risk AND completable this pass; a quiet honest night.

## What was reviewed
- **CLAUDE.md in full**; continuity state (`ledger.md`, `focus.md`, `metrics-latest.json`, latest handoff 11-01, `docs/sessions/2026-11.md`).
- **Inbox drained:** one new filing since the 11-01 pass — `2026-11-02T0713Z` (daytime monitor, artifact-validation roster drift #114: 11 named vs 16 live). Disposition below (QUEUED). Inbox left untouched (append-only).
- **Git:** `origin/main` = HEAD = `49dce79b5` at run start; did not advance mid-run. Last ~48h had heavy Claude Code / Cowork activity (UFC art mirror, #221/#222/#223/#142, packs Chase view) — every touched file treated as HOT; nothing edited.
- **Health triage** (Section 2) via `rpc_ops_snapshot()` + drill-downs; **post-ship watch** first; **Vercel** separately.

## Health-drift findings + deltas (baseline = 11-01 metrics-latest)
- **Security:** clean — invariants [], anon_write_holes [], rls_off_base_tables [], secdef_anon_violations [].
- **Trust health:** 0 breaches, all 40 legs ok. candy_sales_stale_hours 509.7 (< 1114.9 re-verify clock, ~11-27), edition_integrity_flags 22 (<250), panini_coverage_pct_drop 5.9 (<15), **panini_fmv_stale_hours 0 (was 16.2 — Panini ingest/enum resumed)**, trust_precompute_max_age 5.29 (<13).
- **Structural:** stalled_pipelines [] (panini-ingest-enum **no longer stalled** — the 11-01 benign watch cleared when the laptop runner resumed). backward_cursor_rewinds/wmc_null_edition_key/search_path_drift/procedure pins/cross_collection_mat_staleness/suppression drifts all []. sentinel_ts_uuid_editions_48h 0, ts_uuid_dupes_created_24h 0.
- **pipeline_alerts:** 5 rows, all `info` / designed (Atlas 403 arms + flow-rest-moment-moved-400); freshness good (last drains/200s 09:05Z, newest events 09:03Z). Each escalates only on a freshness/stuck condition none of which is met.
- **pipeline_fails_24h:** all low, upstream 0 — pack-mint-probes 12, atlas-pack-market 8, pack-nft-identity 4, others ≤1. **pack-mint-probes verified recovered:** the 12 fails were a `Couldn't resolve host name` (DNS/egress) cluster confined to 11-01 ~20:48–21:03Z; last 4 runs (08:53–09:08Z) all ok=true. Transient, self-recovered.
- **Post-ship watch — GREEN:**
  - **#219 league backfill:** null_league_classified 0, wnba_mislabeled_nba 0 → holds.
  - **#222 lock-check:** every recent `lock-check-batch` run ok=true, `extra.absent_from_chain` 0, group_errors []/batch_read_errors [], skipped_locked 0 (is_locked preserved) → holds, no phantom rows.
  - **#217 reprice-drifted-rips:** next run is ~4:26 AM PT (after this pass); last run (11-01 ~11:26Z) was fine. Nothing to re-measure yet.
- **Vercel:** latest prod deploy `dpl_4fyyw2…` **READY on `49dce79b5`** (= HEAD). Two CANCELED are docs-only rapid-succession build supersession (cosmetic). Runtime errors 24h: 3 groups, all chronic + low-count + graceful-degradation (pack_realized_ev 5s ×2 since 08-23; Panini premiums 8s ×1 since 10-14; player top sales statement-timeout→degrade-to-empty ×1 since 07-27). **No new group.**
- **WATCH — db size +2,014 MB (42,335 → 44,349):** top tables — panini_card_serials 9,267 (steady real Panini ingest growth), `net._http_response` 2,845 (pg_net response table mid-fill; the documented sawtooth, swings ±~1.3 GB and self-prunes), wmc 2,713, pack_rips 2,351, sales_2026 2,071. The +2 GB is above the stated ±1.3 GB band but consistent with `_http_response` being mid-fill plus Panini growth; no public table shows a staleness/integrity flag. **Next pass:** confirm `_http_response` comes back down within a day; if it does not, or a public table grew > 200 MB between passes, escalate (per the 10-30 steer's regression definition).
- **FMV churn (HIGH+MED, compute 05:35Z):** nba 6,578 (−3), panini 18,022 (−8), nfl 1,628 (+7), **pinnacle 909 (−46)**, candy 68 (−3), golazos 1, ufc 0. Editions all flat (panini 40,153 / nba 14,609 / nfl 6,190 / golazos 575 / ufc 617 / candy 125). Pinnacle HIGH+MED has slid two passes running (996→955→909, ~−87) but pinnacle FMV is fresh (stale_hours 1.5), 0 impossible flags, 0 pct_stale_30d — this is confidence-bucket churn as sales age out, not a defect, and FMV route logic is OFF-LIMITS. Note for continuity; not actionable tonight.

## QUEUED (needs Trevor / a non-sandbox lever)
- **#114 artifact-validation roster drift (inbox 2026-11-02T0713Z) — NEW, QUEUED.** `docs/cowork-skills/` holds **16** dashboard HTML sources; the #114 register's RESOLVED-10-20 name→URL map records **11** published claude.ai artifacts; the monitor's §1b roster lists **11**; the register's 09-14 re-read note still says "15 live". The 5 extra source files — `rpc-insights-health`, `rpc-pipeline-reliability`, `rpc-rookie-supply-ladder`, `rpc-security-drift`, `rpc-trade-in-value-finder` — have **no published artifact URL recorded anywhere** in the register. The monitor confirmed all 16 files' SQL objects resolve live, but "objects resolve" ≠ "is a published, validated dashboard."
  - **Why not auto-shipped:** the complete fix spans (a) a **decision** on the 5 — publish + add to the #114 map and the §1b roster, or document them as excluded (drafts/retired sources) — which I can't make without knowing their publish status; and (b) an edit to the **daytime-monitor scheduled-task prompt's §1b roster**, which is not a repo file and is not something to change autonomously. The repo-doc half alone (editing #114) would be guessing at the disposition and does not close the operational gap (future daytime runs still validate only 11). Pure-docs but genuinely needs your call.
  - **Ready-to-run once decided:** if the 5 are live → stage each, confirm its published artifact URL, add name→URL lines to #114 and the §1b roster, re-run `npm run docs:issues-index` (expect add-only). If excluded → add a one-line "excluded from validation because …" note per file to #114. Either way update the monitor prompt's §1b roster to match.
- **panini-ingest-enum 738-min cadence threshold (carried, OPTIONAL, low value):** relax/annotate so a weekend-quiet enum (laptop runner closed) stops surfacing near-threshold `info`. Trevor/Claude Code call. The threshold fired correctly at `info` on 11-01; not a defect.
- **#58 OPENSEA_API_KEY (carried, P2, Trevor-only):** secret, no sandbox lever. candy_sales_stale is a re-verify clock (~11-27), low pressure.
- **topshot-active-listings-ingest egress_blocked (carried, WATCH):** intermittent egress/WAF block on a low-volume lane; the backstop-attribution fix shipped 11-01 (`25bdf5a1e`); the pooled 3-day alert ages out on its own. Monitor only.

## Shipped / Failed / Reverted
None. No production change this pass.

## Metric to re-check next pass
- `net._http_response` size back down within a day (db-size watch); any public table > 200 MB between passes = escalate.
- Pinnacle HIGH+MED (continue the 996→955→909 trend; a fresh-FMV collection losing coverage over several passes would warrant a look, but it is churn, not a read failure).
- Post-ship watches #219 (0/0), #222 (`absent_from_chain` small/0), #217 (daily small `rows_written`, no 57014).
