# RPC monthly deep audit — run 4 (2026-08-27 PT)

Executed overnight 2026-08-27 ~22:00 PT → 2026-08-28 ~00:00 PT by the scheduled Cowork deep-audit task.
Six parallel read-only sweeps (A security · B pipelines · C data integrity · D rendered DOM · E codebase/backlog · F growth/SEO),
then triage, fixes, QA. Register: [deep-audit-register.md](deep-audit-register.md) (rewritten same commit).
Ledger entry: 2026-08-27 "MONTHLY DEEP AUDIT RUN 4".

⚠ A concurrent night-pass session was ACTIVE during this audit (rwfc revert, #38 correction, docs:issues-index
fix all landed mid-run). Every rate below states its window; nothing here pools across its deploys.

## Headline

- **0 P0s.** All 11 register security probes clean; advisors carry 0 ERROR-level lints; credential grep 0 real hits;
  IDOR sweep of every route changed since 08-22 clean.
- **First fully-clean rendered-DOM sweep on record**: 18 surfaces in real Chrome, anonymous, zero honesty-class
  defects, zero console errors, zero hydration errors. D12b retirement copy live; degraded copy honest everywhere sampled.
- **Traction (the number that matters):** 23 registered users (+3/30d), WAU proxy **~31** wallet-bearing identifiers/7d,
  wallet_paste **24/7d — a real ~5× spike this week** (weekly: 1·5·1·5·**24**), **10 of 36 pastes/30d arrived from AI
  answer engines** (chatgpt.com dominant) — the 08-01 robots decision is measurably paying off. email_subscribers **0 all-time**.
  support_conversations 4/30d human. Vercel Web Analytics NOT enabled (API 404).
- **Accuracy gate (R41):** both figures ROSE — canonical TS **55.0** (was 49.7), all-rows **39.21** (was 34.3).
  Per-collection precompute: candy 63.2 · pinnacle 44.0 · allday 23.4 · golazos 0.2 · ufc 0.0.

## Shipped this run (details + revert paths in the ledger entry)

1. Migration `20260828055741` — R38 session_id floor 1→20 (writer population measured first) + `search_path`
   pins on the two dune fns (R14 class checked: prokind='f', no COMMIT).
2. pg_cron 355 moved off the /3 hour grid (`23 1-22/3`), jobid/owner preserved.
3. pg_cron 256 unscheduled — zero readers across all 7 caller sources; ~2.4 h/30d of `cron_heavy` ceiling time freed;
   function/cache/pin kept; one-statement revert.
4. 166 AllDay `badge_editions.avg_sale_price = 0` → NULL + writer guards in `scripts/ingest-allday-badges.mjs`
   and `app/api/cron/allday-badge-ingest/route.ts` (fabricated-zero shape at rest; no current renderer displays it — latent trap closed).
5. `lightpanda` added to track-funnel `BOT_UA` + test (250 events/7d passed the human filter).
6. Wallet-backfill GHA backstop experiment shipped exactly as specified by inbox 08-28T0420Z
   (`sleep 60→300` + `timeout-minutes 10→25`, one commit, falsifier in the workflow comment).

## Deliberately NOT shipped

- **`topshot-stub-resolver` deploy** — deployed v28 (07-27) predates the gate-key hardening and the Supabase MCP has
  no secrets verb, so §1 of `rpc-edge-fn-deploy` (secret-before-code) cannot be verified from this session. That is the
  exact 40h-outage shape. Deploy checklist: confirm `<NAME>_GATE_KEY` secret exists in the dashboard → MCP deploy with
  `verify_jwt:false` + `import_map_path` + the `_shared/topshot-stub-parse.ts` dep → verify by the NEXT CRON TICK's
  `pipeline_runs` row (runs ~every 33 min), expecting `rows_no_change_no_onchain_player` ≈ 50. If it reads 0 while
  `rows_resolved` = 0, the Reels diagnosis is wrong.
- **`rpc_thp_leg_impossible_parallel` collection-scoping** — the leg's `editions JOIN sales ON s.edition_id = e.id`
  costs ~200,000 ms/run (202,680 ms observed; job p50 390 s ok / 25% killed at the 600 s ceiling); a variant adding
  `s.collection_id = e.collection_id` returns instantly. NOT shipped because (a) equivalence needs proving over 4.8M
  sales rows (a `sales` row with a wrong collection_id but a correct TS edition_id would be silently excluded), and
  (b) excluding it is arguably an honesty regression — an impossible serial on a miscategorized sale is still impossible.
  Whoever ships it: prove `count(sales s JOIN editions e ON e.id=s.edition_id WHERE s.collection_id <> e.collection_id) = 0`
  in a quiet window first, or add the predicate as an EXISTS against a properly indexed path and compare BUFFERS.
- **jobid 235 `*/6 → */2`** — the dose–response says */2 is the optimum, but it costs ~+2.2 busy-h/week on an instance
  pinned at 100% of its IO budget by explicit decision (R46). Trevor's trade to make.
- **R21's 29 uncommitted edge-fn sources** — unchanged since the 08-23 baseline (set diff exact); committing them
  requires pulling deployed source, which can carry pre-hardening keys. Operator + Claude Code, not an overnight job.

## Sweep summaries (full evidence in each sweep's numbered findings, condensed here)

**A · Security.** Clean beyond the shipped items. New: 2 `function_search_path_mutable` WARNs on the dune fns (fixed);
R21 fleet drift EXACTLY stable (67 deployed / 38 committed / 29 uncommitted / 21 of those verify_jwt:false — zero churn
vs 08-23 baseline); telemetry route has no rate limit (bounded inputs, metrics-inflation only — optional).
PII/anon exposure 0; secret-length logging 0.

**B · Pipelines.** cron.job 93→100 fully attributed (+7: three insights-MV refreshers 08-22, two pinnacle-trade backfills +
series-detail-rollup 08-23, one self-unscheduling audit probe 08-28). New error classes in 7d beyond the two known:
`deadlock detected` ×5 (4 on jobid 303 — R57, the D8 class), `invalid transaction termination` ×5 (confined to the
R14 incident window, resolved), `permission denied` ×3 (grant lagged schedule on 355/356's first 90 min — pattern:
a new cron_heavy job's grant belongs in the same migration as its schedule). R29 startup timeouts 934/1,261 failures 7d (74%).
apply-fmv-haircut TS leg → R54. drain-conflated-subeditions streak → R55. pack-pool empty-dist redraw → R56.
Kills instrument (`npm run pipelines:kills`): fmv-recalc 60.8% (matches the 64–73% characterization),
candy-listings RECOVERED, wallet-backfill-multicollection RECOVERED on the kill dimension.
Clean: all indexer families, panini-ingest 828/828, series-detail-rollup 48/48, no inert schedules (positive control run).

**C · Data integrity.** R8 mechanism re-derived (Reels, not a clobbering writer — register updated). AllDay badge zeros
fixed (above); 330/5,607 AllDay badge rows NULL player_name (One to Remember set — enrichment gap, honest). 13 setless
TS sets → R58. wmc fossils: **6 rows total** (4 TS keys + 2 legacy UFC) — negligible; Pinnacle's 54k "unmatched" is a
method artifact (no `editions` rows by design). `topshot_impossible_parallel_serials` read 1 at 00:48Z and was REAL —
the auto-raiser fixed the underlying circulation 4 minutes later (edition 258:8891::16, circ 84→317); the arm works.
FMV coverage per collection matches the register exactly (UFC now 100%). Pack-EV fabrication checks all 0.
Pack-pool backlog 330 → **17** (all permanent bundle-shaped residue). Sales sanity 0 anomalies across 4.84M rows;
ingest alive on every live market (Golazos's 4/7d is market noise — 61/30d ≈ its 2.4/day rate).

**D · Rendered DOM.** 18 surfaces, all OK or honestly degraded; table in the sweep record. Notables: collection hub
ROOTS are login-gated while every sub-surface is public (same product-call family as R36 — flagged, not filed);
/insights boards fresh (10:06–10:40 PM PDT stamps); OG/canonical clean on samples; single-brand titles sitewide;
3px overflow on pack-reality → R60.

**E · Codebase/backlog.** CI green on origin HEAD (10 jobs, `!cancelled()` guards verified); CLAUDE.md at 39,923/40,000;
ledger guards pass; TODO backlog unchanged (6 prose); brand tokens exit 0 (396+69 surfaces); E5 budget 42 confirmed;
paginated-range ban at 0; zero new fabricated-number shapes in the since-08-22 diff. The rwfc revert's repo half was
observed in-flight and landed at `a0f52694` mid-audit — no action was needed and none was taken.
Backlog reconciliation produced the owed-items list (a)–(e); (a) shipped this run, (b) decided this run (unschedule),
(c) handed off with checklist, (d) landed by the concurrent session, (e) left to Trevor.

**F · Growth/SEO.** Traction table above. bot_ua under-catch → R59 (rule recorded). Sitemap/robots/metadata/JSON-LD/
first-run path all hold their run-3 fixes. Email capture has zero conversions ALL-TIME (surface reachable per D's sweep;
whether the form fires its event needs one supervised browser test — noted for the next daytime pass).

## Overturned / corrected this run

- **R8's implied "a writer is clobbering names" — REFUTED** (the growth is catalogue growth + display fallback; the
  updated_at churn is the stub resolver's no-op upserts).
- **R45 closed as moot** (phantom rows still gone; deletion still unattributed).
- **R49 Mode 2 gained a second independent non-reproduction** — downgraded to watch-only.
- **R11's live cry-wolf instance cleared** by the candy-listings recovery (structural residual stands).
- **Sweep C's first impossible-parallel probe disagreed with the precompute (0 vs 1) — the disagreement was TEMPORAL**
  (the auto-raiser fired between the two readings), not a predicate error. Recorded so nobody files the probe as wrong.

## For Trevor (decisions only he can make)

1. **R41 — which accuracy figure is the gate** (55.0 canonical vs 39.21 all-rows). Both rising; still undenominated in public copy.
2. **R54 — apply-fmv-haircut's schedule** lives on cron-job.org / Task Scheduler; move it out of the degraded band or approve the leg split.
3. **jobid 235 cadence** (+2.2 busy-h/week for a 3× failure-rate cut) under the R46 no-spend rule.
4. Standing items, unchanged: Sentry quota (dead since 08-18 — the E2E smoke badge is still the only client-side error
   detection), known-issues #22 (defeated purge branch), #20 atlas-proxy, D2b gate-key rotation, R27 inbox archive decision.
