# Rip Packs City — Comprehensive Platform Audit (2026-07-01)

Full health + database + page audit run interactively via Cowork (Supabase MCP, Vercel MCP, Chrome visual QA). Read-only except where noted. Verdict: **platform GREEN, no silent failures, no security drift.** Findings below are ranked by severity; none are outages. The site's Top Shot surfaces are excellent; the actionable work is (a) a newly-found parallel mis-attribution writer leak, (b) All Day / Pinnacle intelligence parity, and (c) two imminent operator items.

Everything asserted here was measured live this session (DB `now()` ≈ 2026-07-02T00:10Z, no clock skew).

---

## 1. Backend health — GREEN

| Check | Result |
|---|---|
| `rpc_ops_snapshot` security | invariants `[]` / anon_write_holes `[]` / rls_off_base_tables `[]` / secdef_anon_violations `[]` (0/0/0/0) |
| `v_rpc_trust_health` | 15/15 metrics ok, breaches `[]` |
| `detect_stalled_pipelines()` | `[]` |
| `check_pgcron_recent_failures()` | `[]` |
| `get_pipeline_alerts()` | 1 INFO (`ufc_sales` resolving_editions — benign) |
| Editions (canonical) | TS 17,489 · AllDay 6,191 · Golazos 581 · UFC 518 — FLAT, no writer leak |
| Sentinel TS-UUID-editions 48h | 0 |
| Unmapped resolution backlog | 29 (breach at 100) |
| DB size | 7,169 MB |
| Vercel prod | `795d99b` READY (classify-acq AllDay batch 300→80). Newer docs commits correctly CANCELED via ignoreCommand. |

**24h pipeline fails = all transient, zero silent stalls.** Every one of the 14 pipelines with a failure in the last 24h has `latest_ok=true` within the hour (connection-pool contention during the studio/on-chain backfill wave). A 14-day silent-stop sweep found only three pipelines idle >24h, all expected: `weekly-db-maintenance` (weekly), `allday-fmv-populate` (known dead no-op — AllDay FMV comes via `fmv-recalc`, trust-health `allday_fmv_stale_hours`=0), and `league-drift-detection` (periodic). GitHub-Actions-fed pipelines (ingest, badge-sync, allday-ingest, pinnacle-*) are all firing and green in `pipeline_runs`.

**Advisors:** security invariants (the authoritative check) are clean; the raw advisor dump is the known ~119 by-design SECURITY DEFINER insights views (not findings, per `rpc-data`).

---

## 2. Scheduled tasks + crons — all firing, two imminent operator flags

All 15 enabled Cowork scheduled tasks have `lastRunAt` matching their cadence (nightly pass fired 07-01 08:02Z; daytime monitor 07-02 00:05Z; weekly/monthly all on schedule). Monitor inbox is empty (drained by the nightly pass). pg_cron clean.

**🔴 IMMINENT OPERATOR ITEMS (need Trevor, not shippable from here):**

1. **Vercel on-demand spend cap ($60) is on track to PAUSE PRODUCTION ~early July.** The `vercel-spend-cap-reminder` one-off fires 2026-07-02. Action: raise the cap in Vercel billing settings, or accept a production pause. This is the single highest-urgency item in the audit.
2. **PostgREST connection-pool exhaustion** — edition/pack/player pages intermittently throw "Timed out acquiring connection from connection pool." Measured root cause (07-01 CC): PostgREST `db-pool` exhaustion, not Postgres `max_connections` (17/90 in use — huge headroom). Fix = raise `db-pool` in Supabase → Settings → Database. The app-side hot-path fan-out was already cut 3→1 (`get_edition_market_bundle`, `e0afec3`), so this is the remaining lever.

Future one-offs already scheduled: GitHub PAT expiry reminder (Aug 31, PAT dies Sep 7), Candy/Solana chain-two tripwire (Jul 8).

---

## 3. Visual QA (Chrome) — per-collection

Sampled representative pages per category per collection and cross-checked data completeness at scale via SQL (stronger than eyeballing 10 random pages). Load pattern note: edition pages hydrate client-side over ~5s; one heavy edition page froze the screenshot renderer (matches the known edition-page perf/pool class).

### Top Shot — EXCELLENT (flagship quality)
- **Edition page** (LeBron `224:8241`): FMV/floor/ask/best-offer/30d-sales all populated; Parallel Printings ladder (Standard $1.06 /5,373 · Blockchain $16.52 /99 · Hexwave $216 /25 · Galactic $96.25 /5); Special Serials (#1 $275 @Buraque, Jersey #23, Perfect #5,373); Recent Sales with usernames resolving; IPFS media verification (video+artwork CIDs); FMV history chart; Pack Provenance (328 pulls observed); "Featured in Insights" cross-link.
- **Parallel `::` child** (Hexwave `224:8241::19`): renders correctly, Parallel Printings ladder cross-links all 4 printings with "VIEWING" highlight, Edition Offer "fillable by any printing," per-parallel special serials (Perfect #25). **Parallels are linked to each other from every printing's page ✅** (the exact thing requested).
- **Badges** (Max Shulga `219:8387`): "Rookie" + "Rookie Debut" chips render.
- **Set page** (Rookie Debut): 327 editions, 1.32M mint, FMV total $10,212, floor total $8,503, tier-mix bar, sortable editions grid, preview montage.
- **Pack page** (dist 7800): exceptional — Observed Lifecycle (21,381 opened / 58,046 pulled / $213,552 realized), EV Reality Check (modeled $1.13 vs realized $10.72, 9.49×, calibrated $9.28), per-tier "Packs Content Remaining", Pull Odds by Tier, Top Chases, Sales History (usernames), full "What's Inside" pool with drop weights.
- **Team page** (Lakers): full hub — 74 players / 580 editions / $60,177 FMV, live game context, Team Checklist w/ wallet-paste, Top Editions, Squeeze & Scarcity, per-player roster with FMV, Sets-featuring list.

### NFL All Day — STRONG parity, data-enrichment lags
- Edition page (Aidan Hutchinson `1347`): FMV, FMV history, Recent Sales w/ usernames, "Found in these Packs" (comprehensive), Special Serials (#1, Perfect). 
- Pack page (Rewind Chance `7580`): full lifecycle + EV Reality Check + Sales History + What's Inside — **but the EV model is uniform** (every edition `Wt 1`, flat `Hit 0.19%`), which the page itself warns "over-states rare-heavy packs" with ~98% of value on stale/no-data FMV.
- Gaps vs TS: no Jersey-Match special serial; weaker buyer/serial resolution (UNRESOLVED serials, `— —` buyers, Flowty-router buyer `0x3cdb…1ff3`); ~1% duplicate sales; pack "Depletion" reads 0% while 75% opened.

### Disney Pinnacle — LIGHTEST (biggest parity gap)
- Overview: 499 editions, FMV confidence 56% HIGH/MED, FMV data age 7 min (fresh). Nav has **only Overview/Collection/Market/Sniper/Analytics — no Packs, no Sets, no Pack Sniper tabs.**
- Render page (`/pinnacle/moment/{render_id}` — a separate, lighter route): "Other Printings of This Pin" variant linking ✅, FMV + confidence, floor, tracked holders, Recent Sales (date/price), rich pin metadata (materials/effects/size).
- Gaps vs TS: **no packs at all** (0 pack distributions); sales lack **serial** ("—") and **buyer/seller**; no FMV history chart; no special serials; no badges; no insider signals; some Recent-Top-Sales rows show "—" (render→character unresolved); confusing "Scarcity vs variant −559.2% MORE COMMON" display; stale overview news blurb ("231 editions tracked", dated 2026-03-28); `pinnacle_catalog.set_name` has a leading space.

---

## 4. Parity matrix (what to replicate)

| Capability | Top Shot | All Day | Pinnacle |
|---|---|---|---|
| FMV + confidence | ✅ full | ✅ (honestly thin tail) | ✅ render-keyed |
| FMV history chart | ✅ | ✅ | ❌ |
| Recent sales | ✅ serial+buyer+seller+username | ⚠️ weaker resolution | ⚠️ no serial, no buyer/seller |
| Special serials (#1/jersey/perfect) | ✅ all three | ⚠️ no jersey | ❌ |
| Badges (moment + special-serial) | ✅ | ⚠️ data-dependent | ❌ |
| Parallels / variants linked | ✅ | n/a (no parallels) | ✅ "Other Printings" |
| Packs (lifecycle + contents) | ✅ | ✅ | ❌ none |
| Pack EV | ✅ drop-weighted + calibrated | ⚠️ uniform weighting | ❌ none |
| Pack sniper | ✅ | ✅ | ❌ |
| Sets tab | ✅ | ✅ | ❌ |
| Teams hub | ✅ | ✅ | n/a |
| Insider signals | ✅ | ✅ | ❌ |
| IPFS media verification | ✅ | ❌ (no catalog) | ❌ |

---

## 5. Findings by severity

### 🟠 Moderate — data integrity / accuracy (hand-off; do NOT blind-mutate the sales writer)

**F1 — Active parallel mis-attribution on new S8 parallels.** 240 sales sit on `::` parallel editions with serial numbers exceeding the parallel's stated circulation (e.g. Hexwave `224:8241::19` /25 showing serial #2617 at $1.00). **235 of 240 are in the last 30 days and the latest is today** — an active writer leak, concentrated on "Club Collection" (`::16`, uniform circ 99) and "Hardcourt" (`::18`, uniform circ 50), sources `onchain` + `offer_fill`. Sample leaked nfts are Standard moments (serials 2,178–3,983, ~$0.40 common prices) not in `topshot_moment_subeditions`, whose sales landed only on the parallel while the base edition exists. Two candidate causes: (a) the sales-indexer mis-resolves some Standard moments onto a `::` edition for these new sets, and/or (b) the `::16`/`::18` `circulation_count` is a seeded placeholder (99/50 uniform). Visible to users as impossible serials on parallel pages; can skew a parallel's floor/recent-sales.
  - Detector: `SELECT count(*) FROM editions e JOIN sales s ON s.edition_id=e.id WHERE e.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND e.external_id ~ '::' AND e.circulation_count>0 AND s.serial_number>e.circulation_count;`
  - Fix path (CC): inspect the sales-indexer edition-resolution + `redirectParallelSales` for these subedition types; confirm real Club Collection/Hardcourt circulation; then a one-time re-key drain of confirmed mis-attributed rows. Do NOT re-key blind — the conflation history shows confident-but-wrong fixes backfire.

**F2 — All Day duplicate sales (~1%).** 295 duplicate groups / 295 excess rows out of 30,571 sales (90d). The `allday_studio_history_v1` backfill and the `onchain`/`onchain_dapper_v1/v2` indexers ingest the same economic sale with different tx representations, so tx_hash dedup misses them. Slightly inflates AllDay sale counts + WAP-based FMV.
  - Detector: same-`nft_id` + same-price + same-day appearing in >1 row across sources.
  - Fix path (CC): a cross-source dedup key (nft_id + rounded price + day) at the writer, then a one-time collapse keeping the resolved row.

### 🟡 Low — display / cosmetic

- **F3 — Serial "#0" in Recent Sales.** 3.5% of TS 90d sales (8,495/240,120) have `serial_number=0` and render as "#0" (serials start at 1). Recommend a display fallback to "—" (All Day already renders "UNRESOLVED"). Recurs on edition + team pages.
- **F4 — Pack count reconciliation on reward packs.** Reward-pack pages show "21,381 opened" next to "510 of 3,240 minted / 84% depletion" — the `pack_distributions` minted denominator undercounts cumulative opens for multi-wave reward packs, making depletion/remaining misleading. (Paid packs reconcile fine.)
- **F5 — Username tail.** 97.7% of TS 30d wallets resolve to usernames; the unresolved ~2.3% skews toward higher-value parallel buyers (why the Hexwave page showed raw `0x…`). Consider prioritizing the resolver on parallel/high-value buyers.
- **F6 — Pinnacle overview polish.** Stale news blurb ("231 editions tracked", 2026-03-28; now 499); `pinnacle_catalog.set_name` leading whitespace (trim must be coordinated across Pinnacle tables that join on set_name); confusing "Scarcity −559.2% MORE COMMON" copy; some Recent-Top-Sales show "—" for character.
- **F7 — Set/team hero montage tiles** render empty on first paint (lazy-load; fill on scroll). Cosmetic.

### ✅ Verified healthy (no action)
Security posture, RLS, pipeline liveness, pg_cron, FMV freshness (all collections), trust-health, parallel-linking, TS special serials + badges, TS pack EV calibration, username resolution (97.7%), edition/set/team/pack templates for TS.

---

## 6. What was already handled (do not re-do)
- `SERIAL-FMV-POWER-MODEL-WEEKLY-TIMEOUT` — already fixed 06-30 (both fns carry `statement_timeout=600s`); the 07-01 queue entry is stale. Next weekly run (07-05) should pass.
- All Day ask/deal wiring, edition-page fan-out bundle (`get_edition_market_bundle`), `get_player_top_sales` partition indexes, classify-acq AllDay batch 300→80, Sentry trace-sampling 1→0.1, pack-hero empty-200 fallback, sitemap `updated_at` fix — all shipped 07-01.
- Declined (do not re-suggest): Dapper-IPFS thumbnails → CDN migration.

---

## 7. Method / caveats
- Visual QA sampled representative pages per category (not all 10×4×3); template quality + data completeness were cross-verified at scale via SQL, which covers the full catalog rather than a 10-page sample.
- No blind writes were made to FMV, sales-writer, or pricing logic — off-limits per `CLAUDE.md` + the parallel-conflation incident history. F1/F2 are handed off with detectors + fix paths rather than mutated in place.
