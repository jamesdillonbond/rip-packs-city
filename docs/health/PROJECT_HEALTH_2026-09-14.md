# Rip Packs City — Project Health Report

> ⛔ **COMMITTED 2026-09-14 ~08:05 AM PT, and one headline changed between compile and commit: thread (3) is CLOSED.** The "live trust breach" this report opens on — `topshot_impossible_parallel_serials` climbing 5→29→35→36, a confirmed live producer needing a destructive re-key **plus** a route-logic writer fix, both gated — **was repaired that same morning (#82 RESOLVED)**: guards shipped on both inflow write points first, then **37 sales + 643 wmc rows** re-keyed to base; the metric **reads 0** (precompute 07:14 AM PT, re-read live at commit time).
>
> ⚠ **Its successor #116 is OPEN and is a different defect, not a residue.** The metric is **parallel-scoped** (`rpc_thp_leg_impossible_parallel` filters `external_id ~ '::'`), so 0 hides **1,727 base-edition** `sales` rows whose serials exceed their own edition's circulation. ⭐ **Its DIAGNOSIS was settled hours after this report was compiled and does not need the chain read the filing planned:** `topshot_atlas_edition_map.num_minted` equals `circulation_count` on **73 of 73** offending editions, so three independent authorities agree circulation is correct and **the `sales` serial is the wrong value** (`moments` carries the same wrong value). **The MECHANISM is still open** — the writer of `sales.serial_number` is untraced, and `serial_number = nft_id` is exactly 0 of 1,727, so it is not an id leak. ⛔ **Still binding: do NOT widen the trust metric to base editions, and NEVER `raise_impossible_parallel_circ()` — Atlas now independently confirms the circulation it would overwrite.**
>
> ⚠ **The register also moved after this report was compiled.** It reads the STATUS INDEX at `#0–#113`; **#114–#117 have since been filed**. Everything else stands as a dated sample — re-derive before quoting.

**Date:** 2026-09-14
**Compiled by:** Claude (Cowork) — automated weekly run
**Sources:** `CLAUDE.md` + `docs/reference/known-issues.md` (Open § + STATUS INDEX, which now reads **111 numbered items — 52 open · 13 partial · 46 closed**, running `#0–#113`, current through the 2026-09-13 entries), `docs/reference/roadmap-status.md` (headline-metric block **re-read live 2026-09-10 22:34 PT, WITH SWEEP POSITION**), `docs/strategy/go-live-2026-09.md` (the M1–M11 bars + B1–B5 blockers, §1 re-measured through 2026-09-12), `docs/overnight/metrics-latest.json` (captured **2026-09-14 01:1x PT / 08:0xZ**, same-day, genuine-overnight), `docs/overnight/ledger.md` (newest heading 2026-09-14), plus a first-hand file-tool scan (`Glob`/`Grep`/`Read`) and file-existence verification.
**Scope:** A single consolidated, themed view of open work — the numbered known-issue slots (`#0–#113`), the go-live bars, the prioritized actions, the overnight operational queue, and the in-code TODO inventory — with suggested severity, effort, and a recommended sequence.
**Prior report:** `PROJECT_HEALTH_2026-09-07.md` (7 days ago). This regeneration mirrors its structure. `_2026-08-31.md` … `_2026-05-22.md` (nineteen prior reports) also live in `docs/health/`.

> **🚨 Tooling note — the sandbox VM shell is DEAD (6th consecutive night), so this run has NO git / rg / wc.** The Sept-8 Windows update broke the Plan9 mount the Linux workspace uses (`status.claude.com` incident, "awaiting Microsoft's fix"); `mcp__workspace__bash` fails to mount this session, exactly as the nightly pass has recorded every night since 09-08. **Everything in this report that needed the file tools (`Read`/`Glob`/`Grep`) is first-hand and current; everything that needed a shell (commit counts, `wc -l` line counts, `git log`) is UNAVAILABLE this run and is flagged where it appears.** The nightly pass has shipped **0 to prod for six straight nights** under this NO-PUSH, and the autonomous handoff/ledger/metrics files sit UNCOMMITTED on the mount until a push-capable pass reconciles them.

> **⚠ Date nuance.** The harness stamps today as **2026-09-14**; the freshest metrics were captured **2026-09-14 01:1x PT** (same day, from the DB). The freshest **accuracy** read is the **2026-09-12 series** in `rpc_trust_health_history` (four legs) plus the **2026-09-10 22:34 PT** hand-derivation; the freshest **demand** read is **2026-09-08** (`go-live-2026-09.md` §1, from `auth.users`). Ledger/session dates are Pacific. Filed under **2026-09-14** per the weekly-regeneration convention (prior report 09-07, exactly 7 days back).

> **Report location stays clean.** All twenty reports (this one included) live in `docs/health/`; the repo root holds none.

> This is a snapshot. `CLAUDE.md` + `docs/reference/known-issues.md` are the source of truth for project memory; `docs/overnight/ledger.md` for what shipped; `docs/strategy/go-live-2026-09.md` for the go-live plan. This doc reorganizes them for triage. **Severity and effort tags throughout are suggestions, not gospel.**

> **Biggest change since 2026-09-07 — a very heavy audit/ship week (register grew ~48 slots, `#0–#65` → `#0–#113`), the go-live accuracy metrics finally became a SERIES, and two things got materially worse: DB storage (+68% to 30.6 GB) and DB saturation (five straight days of spells).** Seven threads. **(1) The register nearly doubled** — 64 numbered items → **111** (`#0–#113`), the largest one-week growth this file has recorded, almost all of it from Claude Code / device-VM Cowork and concurrent Claude docs sessions on Trevor's box, with a striking share opened-and-closed the same day (audit-drain cadence). **(2) M1/M2 became measurable as a distribution for the first time** — `rpc_trust_health_history` (pg_cron jobid 488, `*/10`) began capturing 2026-09-12, plus per-collection `sweep_pct_24h` / `fresh24h_pct` companions shipped 09-10. **M1 (Top Shot) reads 51.3–56.3% across the 09-12 series — four of four legs above the 50% bar** (up from 37.3% a week ago, though the rise was mostly the 09-08 retirement of 6,426 dead priced rows, not a pricing gain). **M2 (All Day) reads 24.3–29.9%, four of four below the 30% bar, and is now measured as LIQUIDITY-gated, not code-gated.** **(3) A live trust breach appeared** — `topshot_impossible_parallel_serials` climbed 5→29→35→36 (a confirmed live producer, #82), needing a destructive re-key + a route-logic writer fix, both Trevor/Claude-Code-gated. Last week trust breaches were 0. **(4) DB storage jumped +12.4 GB in a week** (18,191 → **30,574 MB**, +68%; ~+1.36 GB/day now) — drivers are the Atlas event tables, `cron.job_run_details` with no retention, and the `net._http_response` 13 GB store (#75); reclaim is destructive and Trevor-gated. **(5) DB saturation spells returned hard** — go-live M11 went from "~0 since 08-30" to **five consecutive days of spells (09-09 → 09-12)**, root-caused across #73/#84/#85 (one real consumer, `atlas_listing_verify_dispatch`, was fixed 1,059× on 09-12). **(6) The #22 credential-purge branch was deleted** (marked closed in the register) — but the GitHub GC + credential rotation residue is still queued for Trevor. **(7) The NO-PUSH deepened** — last week the shell was GREEN with only cloud push blocked; this week the shell itself is down, so autonomous shipping is 0 for six nights.

> **Overnight reality — QUIET / QUEUE-ONLY, six nights NO-PUSH.** The 2026-09-14 pass (`np-20260914-b1f7`, desktop) shipped **0**, reverted **0** — shell dead, and the one DB candidate (Q-SCB partial indexes) was not clearly-safe (an active wallet-backfill wave blocks `CREATE INDEX CONCURRENTLY`, past the 02–06Z quiet window, 60 s cap invalid-index risk), plus a concurrent Claude docs session pushing to `main` (#113) tripped the collision gate. Security **4/4 clean** (public invariants 0, anon-write 0, secdef-anon-drift `[]`). **Trust breaches: 1** — `topshot_impossible_parallel_serials=36` (#82; last week 0). **Stalled pipelines: 0.** `rpc_ops_snapshot()` clean. Post-ship watch over the 09-13 `daily-portfolio-snapshot` fix is **green** (00:05 PT run wrote 25 rows, was 0 on old code).

> **Traction reality — flat at WAU 1 (re-read 2026-09-08).** **25 accounts (+1), WAU 1, MAU 5, 114 saved wallets (was 109)**, 0 email subscribers, 24 of 25 users have a saved wallet. The accuracy gate is now stated as a per-collection RANGE, not one estate number: **Top Shot 48–55%** (four 09-12 legs 51.3–56.3), **All Day 24–30%**, **Candy 59%**, Golazos 0.5%, UFC 0.0% (sentinel). **Demand is still the one number that decides everything** — 1 WAU against a 50+ gate — and it did not move.

> **Cost / storage — UP AGAIN, SHARPLY.** DB is **30,574 MB, +12,383 MB** over last week's 18,191 (+68%), now growing **~1.36 GB/day**. Drivers: the Atlas event tables + `cron.job_run_details` (no retention) + the `net._http_response` 13 GB pg_net store (#75). Reclaim is destructive (Trevor-gated). Disk-IO on the SMALL (2 GB / 2-core) instance remains the binding, STRUCTURAL constraint, and it bit this week: **five consecutive days of saturation spells** (M11, #84). The Vercel build-machine downgrade (#61) and a 09-10 spend-cap pause (#76, budget since raised) are the cost mitigations in flight — re-measure at the next invoice (M10).

> **Platform context (unchanged).** **(1) Top Shot's public REST API stays DEAD** (`public-api.nbatopshot.com`); the Atlas backend read from the DB is the feed (#65) — but its internal verify queue is now ~27× underwater (303K backlog, clears 2/tick; users are fine, bloat is internal, 09-13 ledger). **(2) Flowty** frontend shut, API alive and feeding ingest. **(3) NFL All Day** secondary-market only; sales volume roughly halved since the week of 08-24 (the M2 driver). **(4) UFC Strike** Flow market frozen (0 sales; honestly labelled). **(5) Candy / Solana — LIVE, thin** (overview only). **(6) Panini — decided = WC Prizm plane**; bridge not started. **(7) Top Shot's own Atlas tunnel threw Cloudflare 1033 at points (#81).**

> **Operational reality — autonomous Cowork tasks.** `rpc-daytime-monitor` (read-only) and the nightly pass run against this repo; shared state is in `docs/overnight/` (`ledger.md`, `inbox/`, `metrics-latest.json`, `focus.md`, `.lock`). `docs/FREEZE.md` (absent this run → no freeze) halts all autonomous shipping. **Check `docs/overnight/ledger.md` and `docs/reference/known-issues.md` before acting** — the working tree is ahead of any cloud snapshot, because the shippable work this week landed from Claude Code / device-VM Cowork on Trevor's box while the cloud/sandbox pass stayed read-only under NO-PUSH.

---

## 1. At a glance

| Bucket | Count | Notes |
|---|---|---|
| Known-issue slots tracked | **#0–#113** | Register STATUS INDEX: **111 numbered items — 52 open · 13 partial · 46 closed**. ~48 new slots (#66–#113) since last week's `#0–#65`. See §9. |
| Known issues — resolved/closed since last week | **~20** | Heavy audit-drain week; many filed-and-closed same day. Notables: **#22** (purge branch deleted), **#68** (33K dup sales drained), **#69** (retracted as a defect — crawler, not user), **#78**, **#82→** live, **#85/#86/#87/#89/#92/#95/#96/#97/#105/#106/#111/#112**. — §6 / §9 |
| Known issues — open / partial | **~65** | 52 open + 13 partial per the index. Many new (#66, #70–#77, #79–#84, #88, #90–#94, #98–#104, #107–#110, #113). — §3 / §9 |
| Known issues — 🚨 live trust breach | **1** | **#82** — `topshot_impossible_parallel_serials` 5→29→35→36, a CONFIRMED live producer; destructive re-key + single-`if` route-logic writer fix, both push/Trevor-gated. New this week. — §2.4 |
| Known issues — needs Trevor, operator | **several** | **#22** purge GC + rotate (branch deleted, residue owed); **#55** both 2-hourly Routines read `enabled:false` (last fire 09-01); **#58** `OPENSEA_API_KEY` (moot under #64); DB-retention reclaim (destructive); cron-job.org re-enables (offers-sweep, #80 dead lanes). — §2.6 |
| Known issues — regressed / measured-dead (carried) | **1** | **#8 sports-proxy 403** — still measured dead (`sync-nba-projections` 16 runs / 0 ok in 48 h to 09-09); suppressed to 2026-10-14, deferred to preseason. — §2.3 |
| Known issues — removed from the tree by decision | 3 | #1 Cart, #3 Trade Hub, #3b Gifting — DELETED (read-only pivot). Verified still absent this run. |
| Go-live plan | **M1–M11 + B1–B5** | `docs/strategy/go-live-2026-09.md`. Met: M3, M6, M7, M9. Below bar: M2, M4, M5, M8, M10, M11. M1 above bar on the 09-12 series but read as a RANGE. — §2.1 |
| Commits since last report | **UNAVAILABLE this run** | The sandbox shell is dead (6th night), so `git log` could not run. Last week measured ~724; the working tree is heavily ahead again per the ledger, but no count can be stated honestly this pass. |
| Accuracy gate (headline metric) | **Range, per collection** | Top Shot **48–55%** (09-12 series 51.3–56.3, 4/4 legs ≥ 50%); All Day **24–30%** (4/4 legs < 30%); Candy 59.2%; Golazos 0.5%; UFC 0.0% (sentinel); Pinnacle 44.8% (separate leg). ⚠ Top Shot's rise is largely a 09-08 DENOMINATOR event, not a pricing gain. |
| Demand (the critical-path number) | **WAU 1 · 25 accounts · 114 saved wallets** | 09-08 read. Flat. MAU 5. Gate: **50+ WAU**. — §2.1 |
| Open overnight operational items | **standing queue** | NO-PUSH (shell dead #55-adjacent); DB +12.4 GB + retention reclaim (Trevor); M11 saturation (#84); #82 live breach; #22 purge residue; Atlas verify queue 27× underwater; cron-job.org re-enables (#80/#100/#101/#102). — §2.6 |
| Net-new structural workstream | 2 live | Candy/Solana LIVE thin + Panini (decided = WC Prizm, bridge pending). Unchanged. — §2.8 |
| Prioritized next actions | **superseded** | `docs/strategy/roadmap-2026-08-03.md` (accuracy-is-the-gate) + `go-live-2026-09.md` (the numbers + series). Gate: **50+ WAU**. See §4. |
| In-code TODO markers | **0 actionable in live app code** (+2 candy launch-flag "note" branches by design, +6 solana readiness-guard refs, +draft-doc `RESOLVED`/`CLOSED` lines, +test-file `TODO_` sentinel assertions, +a few resolved-narrative false positives) | Measured via `Grep` — §5 |
| Test / DB-invariant pins | **193 `supabase/tests/*.sql` files** | +5 vs last week's 188. Measured this run (`Glob`). Live pin sweep not re-run (needs a shell). |
| CI jobs (ci.yml) | **18** | Measured this run (`Grep` over `.github/workflows/ci.yml`): changes, memory-docs, docs-tests, typecheck, eslint-ratchet, cadence-lint, cadence-escrow-tests, unit-tests-shard, unit-tests, component-tests, worker-tests, workers-typecheck, db-tests, ledger-guard, register-guard, inbox-guard, tree-corruption, edge-deno. |
| Public `/insights` surfaces | **30** | Measured this run: 31 `app/insights/*/page.tsx` files = 30 surface dirs + the index page. |
| Active revenue-blocking items | 0 | By decision — monetization tabled until 50+ WAU. |

**Health read:** The numbers that decide go-live moved the least, and the numbers that decide *operability* moved the most. On the front page, **demand is flat (WAU 1)** and **accuracy is holding around its bars** — Top Shot's four 09-12 legs all cleared 50% and All Day's all sat just under 30% — but the week's real story is underneath: **the register nearly doubled** in a very heavy audit/ship week, **DB storage rose 68% to 30.6 GB** with a destructive-only reclaim path, **DB saturation spells came back for five straight days** (M11), a **live trust breach appeared** (#82, mis-keyed parallel serials), and the **autonomous pass has been unable to push for six nights** because the Sept-8 Windows update killed the sandbox shell. The single most important *product* development is quiet but good: the go-live accuracy metrics finally have a **series** (`rpc_trust_health_history`, jobid 488) and per-collection sweep companions, so M1/M2 can at last be read as distributions rather than hand-noted legs — and read that way, M1 is 4/4 above its bar and M2 is 4/4 below, with M2 now firmly established as **liquidity-gated, not code-gated** (three independent sizings converge at ~+1.6 pt of code-side headroom against a gap that needs All Day sales volume the platform cannot manufacture). Descending, concentrated risk: **(1) demand** — WAU 1 against a 50+ gate, unchanged and still the whole ballgame; **(2) operational drift** — DB +68% storage and 5 days of saturation spells on a SMALL instance whose only real reclaim is destructive and Trevor-gated; **(3) the NO-PUSH** — six nights of 0-shipped means the cloud/sandbox pass is a monitor, not a shipper, until Trevor's box or a push-capable path clears the backlog; **(4) the standing operator items** — #22 purge residue (rotate regardless), #55 disabled Routines, #82's live breach.

### Themes

| Theme | Items |
|---|---|
| **Launch / activation (the whole critical path)** | Public + self-serve ~9 weeks. **WAU 1 / 25 accounts / 114 saved wallets (09-08).** Accuracy at-or-around its bars. The problem is still *demand*. Gate: **50+ WAU** (§2.1) |
| **Accuracy gate now a SERIES** | `rpc_trust_health_history` (jobid 488, `*/10`) since 09-12 + per-collection `sweep_pct_24h`/`fresh24h_pct` (09-10). M1 4/4 legs ≥ 50%; M2 4/4 legs < 30% (§2.1 / §2.3) |
| **M2 is LIQUIDITY-gated, settled by measurement** | All Day code-side levers all bounded (6 · 91 · +1.5 pt; +0.9; +1.1–2.7 for the offer-fill lane) — M2's gap needs sales volume, which halved since 08-24. Not a code fix (§2.3) |
| **DB storage + saturation regressed** | DB **30,574 MB, +12.4 GB** (Atlas events + `cron.job_run_details` + `net._http_response` 13 GB #75); M11 saturation **5 consecutive days** (#84/#73/#85). Reclaim destructive, Trevor-gated (§2.6) |
| **Live trust breach (NEW)** | #82 `topshot_impossible_parallel_serials` 5→36, confirmed live producer; destructive re-key + writer fix, push/Trevor-gated (§2.4) |
| Data-intelligence correctness / honesty | #67 (TS sales ledger lost ~70% of listing sales for 10 days — the M1 numerator cause, Atlas-recovered), #68 (33K dup sales drained), #72/#73/#88/#98 (honest-empty / data-gap fixes), the wallet-search `enrichFailed`-gates-a-second-source rule (09-13) (§2.3) |
| **NO-PUSH deepened** | Sandbox shell dead since 09-08 (Sept-8 Windows update); 6 nights shipped 0; #55 both Routines `enabled:false`; migration-autorecover.yml is the fileless-migration MOP (§2.6) |
| Instrument darkness / operator-owned | #34 Sentry dark (beacon is the detector, no-spend decided); #80 GitHub dropped all schedule events for 2.8 h (every watcher blind); #100 master alarm GHA trigger fires ~27–29% of scheduled; #77 fleet alarm was single-channel (§2.5) |
| Security | **4/4 clean** (public invariants, anon-write, secdef-anon-drift) + the 1 live trust breach #82; #60 (can't revoke anon from net/cron schemas) carried, needs Supabase support (§2.4) |
| Product simplification — READ-ONLY pivot | Cart / Trade Hub / Gifting **DELETED** — verified still absent (§2.9) |
| Chain expansion — Candy LIVE, Panini decided | Candy `/candy-mlb/overview` LIVE thin; Panini = WC Prizm plane, bridge pending (§2.8) |
| SEO (NEW) | #66 — the site has zero external links, so ~31K indexed pages rank on page N; an off-platform link/authority problem, not a code one (§2.3) |
| Tech debt / refactor | Monoliths (DashboardClient / CollectionAnalyticsClient / SniperClient / CollectionTabClient / MarketClient) — **line counts NOT re-measured this run (no shell)**; carried from 09-07 as 2,836 / 1,875 / 1,849 / 1,416 / 1,199, all growing (§3) |
| Deferred hardening (intentional) | Public INSERT-policy tables; `owner_key`→`user_id`; Golazos `highest_offer` gap (settled: no offer source exists); the `sales-serial-backfill` token rotation (a/c shipped, `INGEST_SECRET_TOKEN` still to rotate) |

---

## 2. Critical path — start here

Go-live is **operationally done** (public + self-serve). The forward plan is two layers: **`docs/strategy/roadmap-2026-08-03.md`** (accuracy is the GATE — headline metric is the HIGH/MEDIUM confidence share) and **`docs/strategy/go-live-2026-09.md`** (what "through the gate" means in numbers: M1–M11 bars, B1–B5 blockers, now readable as a series). The only user gate remains **50+ WAU**.

### 2.1 Launch + activation — the metrics are now a series; demand is flat — `Severity: High · Effort: Medium (built + measured, needs traffic)`

The un-gate shipped 07-17; self-serve magic-link signup opened 07-20. Read-only tabs are anonymous for the 5 published Flow collections (+Candy overview); cost-basis/P&L, saved wallets, watchlist, `/dashboard/*`, and every mutation stay behind sign-in.

- **Traction re-read 2026-09-08:** **25 total accounts (+1), WAU 1, MAU 5, 114 saved wallets (was 109)**, 0 email subscribers, 24 of 25 users have a saved wallet. WAU unchanged. n=1 is noise, not a trend.
- **The go-live metrics became a distribution this week.** `rpc_trust_health_history` (pg_cron jobid 488, `*/10`) began capturing 2026-09-12, and per-collection `sweep_pct_24h` / `fresh24h_pct` companions shipped 09-10 — so for the first time M1/M2 can be read as a series instead of a single hand-noted leg. The 09-12 series (four legs): **M1 51.3 / 55.4 / 56.3 / 55.6 — four of four above the 50% bar; M2 24.3 / 29.1 / 29.9 / 29.9 — four of four below the 30% bar**, peaking at 29.9 twice and not crossing.
- **The amplitude is now a number, not a warning:** the within-day range is ~5.0 pt on M1 and ~5.6 pt on M2, so a single leg is worth ~±2.5 pt (M1) / ±2.8 pt (M2) — any claimed movement smaller than that is unreadable from one reading. **The 09-10 trigger (two consecutive legs at 47.9) sits *below* the 09-12 band; its documented response — the declined denormalised-priority walk order — should stay declined until the series says otherwise, per the register's own reasoning.**
- **Bar status (`go-live-2026-09.md` §3):** **Met** — M3 (0 fabricated-number surfaces on the new-user walk), M6 (0 horizontal overflow at 390 px), M7 (client-error detector exists + caught a synthetic error), M9 (verification gate gone). **Below bar** — M2 (24–30% vs ≥30%), M4 (15–25 s cold vs ≤8 s), M5 (7.3 s warm vs ≤5 s), M8 (E2E smoke streak reset 09-10, earliest met ~09-17), M10 (Vercel 75% build compute vs ≤40%, mitigations pending invoice), M11 (DB saturation — 5 consecutive days of spells vs 0-in-7). **M1** is above its bar on the series but must be quoted as a **RANGE**, not a pass.

Suggested next step: the accuracy bars are close enough that the binding item is unchanged — **pick one acquisition channel and run it against the 50+ WAU gate.** Still the single most important item in the whole report. Do not re-open the declined M1 walk-order on the strength of the 09-10 trigger; the series contradicts its premise.

### 2.2 Public intelligence surfaces — 30 public — `Severity: n/a (shipped) · context`

All 30 built surface dirs in `app/insights/` are public (measured this run: 31 `page.tsx` = 30 surfaces + index). Carried honesty risks: `#50` (`/insights/pack-reality` "Honest +EV ranker" draining while both catching arms read greener), `#33` (ISR bakes a failed read into the whole `revalidate` window). New this week: `#66` (SEO — zero external links, ~31K pages ranking on page N), `#72` (`/api/pack-listings/historical-pulls` published a pull count from a partial read), `#88`/`#98` (tiles Trevor asked for that the data cannot yet answer honestly — surfaces fixed, data gap open).

### 2.3 Data-intelligence — the sales-ledger recovery, M2 settled as liquidity-gated, accuracy holding — `Severity: Medium (green; operator items) · Effort: mixed`

**FMV HIGH/MEDIUM share (read as a range, per collection):** Top Shot **48–55%** (09-12 series 51.3–56.3; ceiling ~68% on the fresh cohort), All Day **24–30%**, Candy **59.2%**, Golazos **0.5%**, UFC **0.0%** (empty-fresh-cohort SENTINEL, never a percentage), Pinnacle **44.8%** (separate leg). ⚠ **Top Shot's week-over-week rise (37.3% → ~52%) is largely a DENOMINATOR event** — the 09-08 retirement of 6,426 dead non-canonical priced rows (`20260908035228`) took 6,426 off the denominator and only 163 off the numerator, so the count of Top Shot editions carrying a trustworthy price actually *fell* ~536 over the same week. The numerator's fall is the 08-28 → 09-06 sales hole (#67) working through the 30-day window.

**Shipped / measured since last week (mostly from Claude Code / device-VM Cowork on Trevor's box):**

- **`#67` — the Top Shot sales ledger had lost ~70% of listing sales for ten days, and it's been recovered from the Atlas firehose.** ~74,297 historical Atlas sales; 6,589 recovered into the live 30-day window (measured at the sales level as +425 editions at MEDIUM-or-better, rarity-biased toward the rarest tiers). ⚠ The historical-half backfill (jobid 481) was **unscheduled the same night** after causing an IO spell, so `remaining` is frozen — the forward recovery landed, the historical pacing did not.
- **`#68` — 33,000 duplicate `sales` rows drained (09-08).** Cross-source pairs written twice by `topshot_gql` and the on-chain/offer lanes (they disagreed on `sold_at` by ~3.4 s, so `idx_sales_tx_nft_sold` never caught them). Backed up row-for-row; the M1 effect was measured at ~−0.5 pt, not the ~4 pt first predicted-and-retracted. **The per-partition UNIQUE constraint shipped** so it cannot recur.
- **M2 established as LIQUIDITY-gated (not code-gated).** Three independent sizings converge: completing the sweep lifts ~6 editions (+0.1 pt); a perfect confidence-rule lift is ~+1.5 pt → ~29%; the missing All Day accepted-offer (OffersV2) lane is worth +1.1 to +2.7 pt but pays out only after a 30-day window (the backfill is the actionable half, a bulk `sales` write, Trevor's call). All Day sales volume roughly halved at the week of 08-24 — **liquidity cannot be manufactured by a faster sweep or a looser threshold** (#70).
- **`#69` — the client-error beacon's "first real finding" was RETRACTED as a defect (09-11).** The 17 events were a headless crawler (`Lightpanda/1.0`), not user-facing; the `ua` field was in the payload all along. Two real instrument defects came out of it and are fixed: the beacon now carries a per-tab `sid` actor key, and the `client_error_burst` alert arm now filters bot UAs out of its threshold.
- **`#85` — `atlas_listing_verify_dispatch` fixed 1,059× (09-12).** It was grouping/sorting 261,531 nft_ids every 2 min to return two (57,176 buffers + a 7.6 MB temp spill → 54 buffers); jobid 466 went from 14.6% → 85.7% of ticks succeeding. It did **not** by itself end the M11 spell (the burst ended 52 min before the migration).
- **Honesty rule added (09-13):** *a failure flag for ONE source must not gate a field fed by ANOTHER* — `/api/wallet-search`'s `isLockKnown` had returned `false` whenever `enrichFailed`, which (with the Top Shot GraphQL host dead) would have rendered `—` over ~1.16M genuinely-checked lock readings. Fixed; the rule is in `key-files-and-honesty.md`.

**Carried / open:**

- **`#8` — sports-proxy `403` remains MEASURED DEAD.** `sync-nba-projections` 16 runs / 0 ok / 0 rows in 48 h to 2026-09-09. Alarm suppressed to 2026-10-14; projections deferred to preseason (~Oct). Operator-only. Do NOT retire (sole writer for `nba_players`/projections).
- **`#66` — SEO (NEW):** the site has zero external links, so ~31K indexed pages rank on page N. An off-platform authority problem, not a code fix.
- **pg_cron waste cluster** (#42/#43) carried; the Atlas verify queue is ~27× underwater (303K backlog; users unaffected, internal bloat — the lever is external-API + pg_net cost, needs a decision, 09-13 ledger).

### 2.4 Security, confidentiality + test infrastructure — `Severity: Medium (green scans; 1 live trust breach) · Effort: mostly landed`

- **Security scans GREEN, 4/4 clean.** `metrics-latest.json`: public invariants 0, anon-write surface 0, secdef-anon-exec-drift `[]` (re-verified 2026-09-14).
- **🚨 1 LIVE TRUST BREACH — `#82` (NEW this week).** `topshot_impossible_parallel_serials` climbed 5 → 29 → 35 → 36 (monotonic = a CONFIRMED live producer). Fix is a **destructive re-key of the mis-keyed sales + a single-`if` route-logic writer fix** — both push- and Trevor/Claude-Code-gated, so queued, not shipped. The "is it live" question is answered; do not re-file it.
- **`#83` (partial):** the decoder no longer writes the custodian, but 9,486 existing rows still name it — a backfill remains.
- **`#60` (carried):** Postgres cannot revoke `anon`/`authenticated` from the `net`/`cron` schemas (those grants are `supabase_admin`'s). Exposure theoretical today (no SECDEF wrapper calls `net.http_get`); real fix needs Supabase support.
- **🚨 `#22` — the credential-purge branch was DELETED (marked closed), but the residue is NOT cleared.** `claude/todo-implementation-e4tib3` was removed from origin 2026-09-07, so the register marks #22 closed — but its pre-purge blob stays fetchable BY SHA until GitHub GCs it, and the metrics queue still lists **"#22 credential-purge GC + rotate"** as owed to Trevor. Action: ask GitHub to GC the unreachable objects and **rotate the credential regardless** (branch deletion does not un-expose a blob already fetched).
- **DB-invariant SQL layer: 193 `supabase/tests/*.sql` files** (+5, measured this run). CI is **18 jobs** in `ci.yml` (measured this run). **Never lower thresholds to green a build.**

### 2.5 Automation / asset hygiene — `Severity: Low–Medium · Effort: ongoing`

The cloud/sandbox pass is queue-only (this run, six nights running). ⚠ **`#34` — Sentry dark since 2026-08-18; no-spend DECIDED, browser SDK off** — the `window.onerror`/rejection beacon → `usage_events.client_error` is the detector (per-tab `sid`; bot-filtered alert arm). ⚠ **`#80` — GitHub delivered ZERO schedule events to this repo for 2.8 h (09-10) and every watcher in the estate went blind** (an alarm sharing its subject's scheduler is no alarm); partly mitigated. ⚠ **`#77` — the fleet alarm was single-channel (Telegram-only)** and had been mute; **`#100` — the master alarm's GHA trigger only fires ~27–29% of scheduled** (move it off GHA or stop the hourly cadence). ⭐ **`#62` — true-mobile QA instrument** (`scripts/qa/mobile-sweep.mjs`, 390 px real Chromium) is the only real mobile instrument; carried.

### 2.6 Overnight operational queue — `Severity: Low–High (mixed) · Effort: mixed`

Health scans are GREEN (0 stalled pipelines) but two operational axes regressed. Open items:

| Item | Issue | Severity | Notes |
|---|---|---|---|
| **NO-PUSH — sandbox shell dead 6th night** | Sept-8 Windows update broke the Plan9 mount; `mcp__workspace__bash` fails. The nightly pass has shipped 0 to prod for six nights; handoff/ledger/metrics sit uncommitted on the mount. | **High (operator)** | A push-capable pass (Trevor's box / device VM / laptop `cowork-push` queue) must reconcile and commit. `.github/workflows/migration-autorecover.yml` recovers fileless migrations 3×/day. |
| **#55 — both 2-hourly Routines `enabled:false`** | Last successful fire 2026-09-01; the cloud Routine binding is immutable, so re-create on Trevor's box with `requires_local_device`. | Med (operator) | One click on one machine; re-verified still disabled 09-08. |
| **DB +12.4 GB / week + retention reclaim** | 18,191 → **30,574 MB** (+68%), ~+1.36 GB/day. Drivers: Atlas events, `cron.job_run_details` (no retention), `net._http_response` 13 GB (#75). | **High (structural)** | Reclaim is DESTRUCTIVE (Trevor-gated). Book retention on `cron.job_run_details` + Atlas events. |
| **M11 — DB saturation, 5 consecutive days (#84)** | 09-09 → 09-12 startup-timeout bursts; #73 shows the metric is a cliff function (0 until it explodes). One real consumer removed (#85). | **High (structural)** | The named amplifier (jobid 355) is a thermometer, not the trigger; batch-size + reschedule levers are Trevor's. |
| **#82 — live trust breach** | Mis-keyed parallel serials, monotonic climb. | **High** | Destructive re-key + writer fix, push/Trevor-gated. |
| **#22 credential purge** | Branch deleted; blob still fetchable by sha; rotate regardless. | **P0 (operator)** | GitHub GC + credential rotation. |
| **#8 sports-proxy 403** | Measured dead; alarm suppressed to 2026-10-14. | Med (operator, deferred) | Do NOT retire (sole writer for projections). |
| **cron-job.org re-enables** | offers-sweep, apply-fmv-haircut, #80 dead lanes set inactive. | Med (operator) | Console edits on Trevor's box. |

### 2.7 Pack EV / pack-viz — `Severity: Low (honest by construction) · Effort: landed`

Carried. Pack-EV surfaces label rows for packs nobody can buy and disclose AllDay/Golazos EV as an original-supply model; Candy leads with Typical-Pull median. The `compute-*-pack-ev` edge functions are in the drifted set (operator-gated redeploy). ⚠ Deferred-hardening note: `buildTopshotPoolPayload`'s `|| 1` fabricated-divisor is LATENT (0 degenerate distributions; its only caller, jobid 16, is inactive) — the EXIT is to emit no rows at `totalCount === 0` when the pool lane is revived, not a standalone deploy.

### 2.8 Chain foundation — Candy LIVE, Panini decided — `Severity: Low (shipped) · Effort: landed`

- **Candy / Solana — LIVE, THIN:** `CANDY_MLB_PUBLIC = true` (verified this run), `pages: ["overview"]`, `is_active = true`, 125 editions. Overview tab only; no Collection/Packs/Sniper tabs (Flow-dispatched components with zero Solana arms).
- **Panini — DECIDED = the WC Prizm plane** (`PANINI_PUBLIC = true`, verified this run): the plane with data (4,910 `panini_editions`, 46K FMV rows, the squeeze board) over the empty OpenSea registry. **Bridge NOT started.** `#58` (`OPENSEA_API_KEY`) is moot under this decision unless the OpenSea plane is revisited.
- **Chain-abstraction Phases A–F complete.** 17 Cloudflare worker dirs (carried; not re-counted this run — no shell).

### 2.9 Read-only product pivot — carried, verified still in effect — `Severity: n/a (landed) · Effort: (done)`

Cart, Trade Hub, and Gifting remain **deleted from the tree** — verified this run by absence: `lib/cart`, `lib/trade-escrow`, `app/dashboard/trade-hub`, `app/dashboard/gift` all absent. The product is purely read-only.

---

## 3. Known issues — by theme

Severity/effort are suggestions. "#" = the item number in `docs/reference/known-issues.md`. **§9 has the verified open/resolved status of the items that moved this week.**

### Launch / activation (the whole critical path)

| # | Issue | Severity | Effort |
|---|---|---|---|
| — | **Traffic / WAU.** Public + self-serve ~9 weeks; **WAU 1 / 25 accounts / 114 saved wallets (2026-09-08)** — flat. Accuracy at/around its bars. Gate: **50+ WAU**. | **High** | Medium (assets built, channel unrun) |
| — | **Go-live bars M1–M11.** Met: M3, M6, M7, M9. Below bar: M2, M4, M5, M8, M10, M11. M1 above bar on the series but read as a range. | High | Mixed |

### Cost / storage + saturation (worsened)

| # | Issue | Severity | Effort |
|---|---|---|---|
| 75 / retention | `net._http_response` ~13 GB store + `cron.job_run_details` / Atlas events with no retention; DB +12.4 GB/week to 30.6 GB. | **High** | Small SQL, but DESTRUCTIVE (Trevor's call) |
| 84 / 73 | DB saturation spells 5 consecutive days (M11); the metric is a cliff function (#73). Named amplifier jobid 355 is a thermometer. | **High** | Reschedule / batch-size levers, Trevor-gated |
| 56 | `wmc` index bloat regrows ~64 MB/day; instrument claims stale, RATE confirmed; no reindex job. | Med | Small (book a cadence) |
| 61 / 76 | Vercel bill 75% build compute → Standard downgrade (09-06); a 09-10 spend-cap pause (#76, budget since raised) briefly downed the site. | Med | Re-measure at invoice (M10) |

### Data-intelligence correctness / honesty

| Item | Issue | Severity | Effort |
|---|---|---|---|
| 67 | TS sales ledger lost ~70% of listing sales for 10 days; forward-recovered from Atlas, historical pacing (jobid 481) unscheduled. | Medium | Landed (forward) / decision (historical) |
| 70 | All Day M2 slide is a real numerator loss; LIQUIDITY-gated, not a writer defect. | Medium | Not a code fix |
| 50 | `/insights/pack-reality` "Honest +EV ranker" draining; both catching arms read greener. | Medium (open) | Small–Medium |
| 72 / 88 / 98 | Honest-empty / data-gap items (partial reads, tiles the data can't answer yet). | Medium | Mixed |
| 33 / 39 | ISR bakes a failed read into the `revalidate` window; `/insights/underpriced-serials` 503s — both Trevor's call. | Medium (Trevor) | Small–Medium |

### Instruments / darkness / operator

| # | Issue | Severity | Effort |
|---|---|---|---|
| 55 | Both 2-hourly Routines `enabled:false`; sandbox shell dead → NO-PUSH 6 nights. | Med–High (operator) | Small (recreate on device) |
| 34 | Sentry dark since 08-18; no-spend decided; beacon is the detector. | Med (operator) | Shipped (beacon) |
| 80 / 77 / 100 | GitHub dropped all schedule events 2.8 h (every watcher blind); fleet alarm was single-channel; master alarm GHA trigger fires ~27–29% of scheduled. | Med | Move alarms off GHA / multi-channel |
| 60 | Postgres cannot revoke anon/authenticated from net/cron schemas; needs Supabase support. | Low–Med (operator) | External |
| 62 | True-mobile QA instrument (`mobile-sweep.mjs`, 390 px real Chromium). | Low (instrument) | (landed) |
| 58 | `OPENSEA_API_KEY` unset → 2 Panini surfaces 502. **Moot** under the #64 WC-Prizm decision. | Low (moot) | Trivial if revisited |

### Security

| # | Issue | Severity | Effort |
|---|---|---|---|
| 82 | 🚨 LIVE trust breach — mis-keyed parallel serials, monotonic climb. | **High** | Destructive re-key + writer fix (Trevor/CC) |
| 83 | Decoder fixed; 9,486 existing rows still name the custodian (backfill owed). | Med (partial) | Medium |
| 22 | 🚨 Credential purge — branch deleted, blob still fetchable by sha; rotate regardless. | **P0 (operator)** | GitHub GC + rotation |

### Tech debt / refactor

| # | Issue | Severity | Effort |
|---|---|---|---|
| 14 / 10 | Monolith page refactor — Phase 2 remains. ⚠ **Line counts NOT re-measured this run (no shell)**; carried from 09-07 as DashboardClient 2,836 / CollectionAnalyticsClient 1,875 / SniperClient 1,849 / CollectionTabClient 1,416 / MarketClient 1,199, all growing. | Low–Medium | Large |

### SEO / growth (NEW)

| # | Issue | Severity | Effort |
|---|---|---|---|
| 66 | Zero external links; ~31K indexed pages rank on page N. | Med | Off-platform (not code) |

### Stalled / scaffolded + deferred hardening

- Cart / Trade Hub / Gifting — **DELETED, verified still absent.** Breaks — dormant (tables not in prod).
- Deferred hardening (intentional): `email_subscribers`/`outbound_clicks`/`portfolio_snapshots`/`support_conversations` public INSERT policies; `user_achievements`+`watchlist_items` still on `owner_key` (text); Golazos `highest_offer` gap SETTLED (no offer source exists — do NOT build the indexer); `sales-serial-backfill` token — (a)/(c) shipped, **`INGEST_SECRET_TOKEN` still to be rotated** (Trevor, ~15 functions).

### Architecture notes worth tracking

- **Two "collection vocabulary" and two "confidence vocabulary" footguns** persist by design. Re-read `CLAUDE.md` before any new query.
- **Supabase compute is `SMALL` (2 GB / 2-core)** — saturation is disk-IO-bound and STRUCTURAL. The DB is now **30.6 GB (+68% this week)**; three tables holding 5.7 GB are 60% of all disk reads (`wallet_moments_cache` 33.0% / `fmv_snapshots_2026` 13.9% / `sales_2026` 12.8%) and they are one chain, so any M11 fix that doesn't touch the FMV recompute path trims only 40% of the problem.
- **A function-level `SET statement_timeout` is INERT on pg_cron** (`#43`).
- **Eight caller sources** — including a Windows Scheduled Task on Trevor's box and cron-job.org — are invisible to a repo grep. Enumerate all before calling any ingest dead.

---

## 4. Prioritized next actions — **superseded**

`CLAUDE.md`'s old list is replaced by **`docs/strategy/roadmap-2026-08-03.md`** (accuracy-is-the-gate) and **`docs/strategy/go-live-2026-09.md`** (the numbers + the new series):

| Phase | Action | Status |
|---|---|---|
| Gate | **Accuracy is the GATE — HIGH/MEDIUM share must beat incumbents.** | **At/around the bars — Top Shot 4/4 legs ≥ 50% (09-12 series), All Day 4/4 legs < 30% (liquidity-gated). Read as a range.** |
| Go-live | **M1–M11 bars, now a series.** | Met: M3, M6, M7, M9. Below bar: M2, M4, M5, M8, M10, M11. |
| 1 | **Prove the product with real users — 50+ WAU.** | **Open — the critical path. WAU flat at 1 (2026-09-08).** |
| 2 | Cost / latency / saturation levers. | **Worsened — DB +12.4 GB, 5 days of M11 spells; reclaim destructive (Trevor).** |
| 3 | Durable debt. | Heavy advance — #67 sales recovery, #68 dup drain, #85 dispatch fix, honesty rules. |
| 4 | Chain two, readiness-gated. | Candy LIVE (thin); Panini decided = WC Prizm (bridge pending). |

**Standing guardrails:** no paywall/Stripe until 50+ WAU; no infra spend pre-revenue; **verify pages by rendered DOM, not HTTP 200**; **before gating/short-circuiting any route, enumerate EVERY caller** (eight sources).

**Housekeeping still outstanding:** clear the NO-PUSH (a push-capable pass to reconcile the uncommitted overnight files + drain the queue); recreate the autonomous Routines on-device (#55); book DB retention on `cron.job_run_details` + Atlas events; action the #22 purge GC + credential rotation; ship the #82 re-key + writer fix; rotate `INGEST_SECRET_TOKEN`.

---

## 5. In-code TODO inventory

A first-hand `Grep` scan over `app/ lib/ components/ scripts/ __tests__/ docs/drafts/` (`*.{ts,tsx,js,jsx,mjs,cjs}`; node_modules/.next/.git excluded) found **no actionable markers in live application code** — unchanged in character from prior weeks. Breakdown:

### 5a. Candy launch-flag-gated "note" branches (2 markers) — keep by design

- `app/api/candy-sales-indexer/route.ts:195` and `app/api/ingest/candy-editions/route.ts:182` — `note: "…still a TODO_-prefixed placeholder"` strings inside launch-flag-gated defensive branches. Constants are filled (Candy is live); branches unreachable in practice. Not actionable.

### 5b. Solana readiness-guard refs (6 markers) — guard functions, not open work

- `lib/chains/solana/normalize.ts` — the `startsWith("TODO_")` readiness-guard functions (lines 360/364) + their `TODO_3/4/5 RESOLVED` narrative (lines 46/54/59/150/355). Placeholder-guards, not open TODOs.

### 5c. Panini draft/reference lines — draft-only, all closed

- `docs/drafts/panini/ingest-panini-runner.mjs` (`TODO(go-live) RESOLVED 2026-07-16/19`, plus enumeration back-references at lines 17/32) and `docs/drafts/panini/panini-proxy/index.js:19` (`TODO(discovery) CLOSED 2026-07-19`) — annotated resolved/closed draft scaffolding.

### 5d. Test-file `TODO_` sentinel assertions — coverage, not open work

- `__tests__/solana-normalize.test.ts` (lines 115–131), `__tests__/api-candy-sales-indexer-deep.test.ts:127`, `__tests__/api-ingest-candy-offers-deep.test.ts:112`, `__tests__/api-wallet-backfill-candy.test.ts:13,40` — tests that assert the `TODO_`-prefix readiness guard behaves (i.e. they *pin* the sentinel, they are not themselves TODOs).

### 5e. Narrative / false positives (rest)

- `lib/rtr-lock-roi-weights.ts:7` + `app/api/rtr/lock-roi/route.ts:38` ("resolves the standing … TODO" / "v2 folds in the two signals the v1 TODO called out"), `lib/format.ts:6` (a `"$X,XXX.XX"` format doc), `scripts/check-edge-fn-drift.mjs:273` (a drift-scanner literal). All describe *resolved* work or are tooling literals.
- ⚠ **Method note:** the sandbox shell is down this run, so the whole-repo `ripgrep`/`grep -r` used in prior reports could not run. The scan above used the `Grep` file tool with a source-file glob, which returns promptly and covers the same source tree. The `workers/**/node_modules/` vendored TODO markers are third-party and excluded by the glob.

> **Net change since last week:** none of consequence. Live application code has zero actionable TODO markers. (Line numbers stable: candy-sales-indexer note at 195, candy-editions at 182.)

---

## 6. Resolved / no action needed

Verified against `docs/reference/known-issues.md` STATUS INDEX and `docs/overnight/metrics-latest.json`:

**Carried, still resolved:** #0, #1/#3/#3b (Cart/Trade Hub/Gifting — deleted, verified absent), #4 (Pinnacle FMV), #5, #7, #9, #12 (file absent), #15, #19, #24, #27, #28, #30, #36, #37, #44, #45, #46, #47, #53, #57. ⚠ **#8 remains REGRESSED / measured-dead** — see §2.3/§9.

**Newly resolved / closed / retracted since last week (heavy audit-drain cadence — many filed and closed same day):**
- **#22** wallet/credential purge — branch DELETED 09-07 (register marks closed; GC + rotation residue owed to Trevor).
- **#23** edge-fn drift — CLOSED 09-08 (drift is 6, not 25; all six deliberate).
- **#31** edge-fn content census — CLOSED 09-08 (superseded by #53; census now runs).
- **#38** topshot-pack-pool-backfill — CLOSED 09-08 by the pause (0 runs in the retention window).
- **#68** 33,000 duplicate sales — DRAINED 09-08; per-partition UNIQUE constraint shipped.
- **#69** beacon "first real finding" — RETRACTED 09-11 (crawler, not user-facing); its two instrument defects fixed.
- **#78** — CLOSED 09-12 (lane healthy, positive control).
- **#85/#86/#87/#89/#92/#95/#96/#97/#105/#106/#111/#112** — closed 09-12/09-13 (dispatch fix, OG card, Pinnacle art cap, various same-session closes).

**Note on churn:** the register grew from ~64 to 111 numbered items in one week; the closed count rose from 25 to 46. This reflects an unusually heavy audit/ship cadence, not a change in project scope.

---

## 7. Suggested sequence

A pragmatic order under **accuracy-is-the-gate** + the go-live bars:

1. **Clear the NO-PUSH.** Six nights of 0-shipped means the autonomous pass is a monitor, not a shipper. A push-capable pass (Trevor's box / device VM / laptop `cowork-push` queue) must `git fetch`, reconcile the concurrent docs-session commits, re-splice the ledger, run the three ledger guards, commit the uncommitted overnight files, and drain the queue. Everything below is gated on this.
2. **Book DB retention (Trevor) — the storage + saturation axis is the week's real regression.** Retention on `cron.job_run_details` + Atlas events + the `net._http_response` store (#75) is small SQL but destructive; it is the lever against both the +1.36 GB/day growth and the M11 spells. Pair with the jobid-355 reschedule / batch-size decision (#84).
3. **Ship the #82 re-key + writer fix (Trevor/Claude Code).** A live trust breach with a confirmed producer should not sit.
4. **Action the #22 purge residue (Trevor):** GitHub GC the unreachable objects and **rotate the credential regardless** — branch deletion does not un-expose the blob. Rotate `INGEST_SECRET_TOKEN` in the same pass.
5. **Recreate the two 2-hourly Routines on-device (#55)** with `requires_local_device` so autonomous shipping resumes.
6. **Drive traffic against the 50+ WAU gate (§2.1).** The accuracy bars are close enough that demand is the binding item; pick one channel. Do NOT re-open the declined M1 walk-order — the 09-12 series contradicts its premise.
7. **Fix the honesty-class open items** — #50 (pack-reality ranker), #33/#39 (ISR / underpriced-serials), #72/#88/#98 (partial-read / data-gap tiles).
8. **Verify the cost mitigations at the next invoice** (Vercel Standard build machine, M10) and **re-read M1/M2 off the `rpc_trust_health_history` series**, never off a single leg.

---

## 8. Notes from verification

- **🚨 Sandbox shell DOWN this run (6th night).** `mcp__workspace__bash` fails to mount (Sept-8 Windows Plan9 breakage, `status.claude.com` incident). So this report has **no `git log` / `wc -l` / `ripgrep`** — commit counts and monolith line counts are UNAVAILABLE and flagged as such where they appear. Everything else below is first-hand via the `Read`/`Glob`/`Grep` file tools, which use a different mount and worked normally.
- **Counts measured this run (file tools):** CI = **18** jobs (`.github/workflows/ci.yml`, `Grep` of job-level keys); DB-invariant test files = **193** (`supabase/tests/*.sql`, `Glob`); `app/insights/*/page.tsx` = **31** (= 30 surfaces + index). DB size, editions-by-collection, security 4/4, 1 trust breach, 0 stalled pipelines come from **`docs/overnight/metrics-latest.json` (2026-09-14 01:1x PT)**.
- **TODO scan: 0 actionable markers in live app code** (§5) — `Grep` over the source glob; test-file `TODO_` sentinel assertions and vendored `node_modules` markers excluded/explained.
- **Deletions verified by absence:** `lib/cart`, `lib/trade-escrow`, `app/dashboard/trade-hub`, `app/dashboard/gift`, `lib/blazers-trivia.ts`, `docs/FREEZE.md` — all absent (`Glob`).
- **Launch flags verified:** `lib/launch-flags.ts` `CANDY_MLB_PUBLIC = true`, `PANINI_PUBLIC = true`.
- **Cited paths spot-checked — all resolve:** `docs/strategy/{roadmap-2026-08-03,go-live-2026-09}.md`, `docs/reference/{known-issues,roadmap-status,database,cron-and-schedulers,key-files-and-honesty,autonomous-tasks}.md`, `docs/audits/deep-audit-register.md`, `components/telemetry/ClientErrorBeacon.tsx`, `scripts/{qa/mobile-sweep.mjs,check-brand-tokens.mjs,recover-fileless-migrations.mjs}`, `lib/{launch-flags,collections,market-closed}.ts`, `app/api/fmv-recalc/route.ts`, `.github/workflows/{ci.yml,migration-autorecover.yml}`. **Absent (correctly):** the four deleted product dirs, `lib/blazers-trivia.ts`, `docs/FREEZE.md`.
- **Accuracy** comes from `docs/reference/roadmap-status.md` (headline block 2026-09-10 22:34 PT) + `docs/strategy/go-live-2026-09.md` (the 09-12 `rpc_trust_health_history` series); **demand** (25 accounts / WAU 1 / MAU 5 / 114 saved wallets) from `go-live-2026-09.md` §1, 2026-09-08. Both are dated samples.
- **Known-issues STATUS INDEX:** its own generated line reads **111 numbered items — 52 open · 13 partial · 46 closed**, running `#0–#113`, derived from each item's own first sentence.
- **Monolith line counts were NOT re-measured** (no shell) and are carried from 09-07; re-measure when a shell returns.
- This report did **not** edit `CLAUDE.md` or any source file and did **not** touch git — it only created this file.

---

## 9. Known-issues reconciliation (verified 2026-09-14)

The register's own generated STATUS INDEX reports **111 numbered items — 52 open · 13 partial · 46 closed**, running `#0–#113`, derived from each item's own first sentence. ⛔ `closed` means the item *says* it is closed — read its own date stamp. Items that MOVED this week (the full slate #4/#5/#7/#9/#11/… carries its prior verified status — see `PROJECT_HEALTH_2026-09-07.md` §9):

| # | Issue | Index status | Verified status | Evidence |
|---|---|---|---|---|
| 8 | sports-proxy 403 | 🟡 open | REGRESSED / measured-dead — 16 runs / 0 ok in 48 h to 09-09; suppressed to 2026-10-14 | known-issues #8 |
| 22 | 🚨 Credential purge | ✅ closed | Branch DELETED 09-07 (register closed); **GC + rotation residue still owed to Trevor** | index + metrics queue |
| 23 | edge-fn drift | ✅ closed | CLOSED 09-08 — drift is 6, all deliberate | known-issues #23 |
| 31 | edge-fn content census | ✅ closed | CLOSED 09-08 — census runs (superseded by #53) | known-issues #31 |
| 34 | Sentry dark | 🟠 partial | Beacon is the detector; no-spend decided; SDK off | known-issues #34 |
| 38 | topshot-pack-pool-backfill | ✅ closed | CLOSED 09-08 by the pause | known-issues #38 |
| 55 | 2-hourly Routines cloud-only | 🟡 open | **Both read `enabled:false`, last fire 09-01** — recreate on-device | known-issues #55 |
| 66 | SEO — zero external links | 🟡 open | NEW 09-06 — ~31K pages rank page N | known-issues #66 |
| 67 | TS sales ledger lost ~70% listing sales 10 d | 🟡 open | Forward-recovered from Atlas; historical pacing (jobid 481) unscheduled | known-issues #67 |
| 68 | 33K duplicate sales | ✅ closed | DRAINED 09-08; per-partition UNIQUE constraint shipped | known-issues #68 |
| 69 | beacon first-finding | ✅ closed | RETRACTED 09-11 — crawler, not user-facing; instrument defects fixed | known-issues #69 |
| 70 | All Day M2 slide | 🟡 open | NEW 09-09 — real numerator loss; LIQUIDITY-gated | known-issues #70 |
| 73 | M11 metric is a cliff function | 🟡 open | NEW 09-09 — startup-timeout is a severity marker, not independent | known-issues #73 |
| 75 | `net._http_response` ~13 GB | 🟡 open | DECIDED 09-13 — reclaim rejected (growth stopped); DB-growth driver | known-issues #75 |
| 76 | Vercel spend-cap pause | 🟠 partial | 09-10 pause confirmed by Trevor; budget since raised | known-issues #76 |
| 80 | GitHub dropped all schedule events 2.8 h | 🟠 partial | Every watcher blind; single-channel alarm | known-issues #80 |
| 82 | 🚨 mis-keyed parallel serials | ✅ closed→**LIVE** | Index reads closed on the trigger, but metrics show a **live producer (5→36)** — re-key + writer fix queued | metrics-latest.json |
| 84 | DB saturation, 5 consecutive days | 🟡 open | NEW 09-11 — jobid 355 is a thermometer; batch/reschedule Trevor-gated | known-issues #84 |
| 85 | `atlas_listing_verify_dispatch` 1,059× | 🟠 partial | Query fixed+shipped 09-12; coverage gap underneath open | known-issues #85 |
| 100 | master alarm GHA trigger ~27–29% | 🟡 open | DECIDED 09-13 — move off GHA / stop hourly | known-issues #100 |
| 101 | topshot-misattrib-drain backlog | 🟡 open | Growing since 09-08 unscheduling — re-point to Atlas or accept | known-issues #101 |
| 113 | concurrent docs session | 🟡 open | Cause of this run's collision-gate NO-PUSH | known-issues #113 |

**Tally (per the register's own STATUS INDEX):** **111 numbered items — 52 open · 13 partial · 46 closed**, running `#0–#113`. Plus the go-live plan (M1–M11 / B1–B5, now a series), the per-collection accuracy ranges, Candy live + Panini decided, **18-job CI**, **193 DB-invariant test files**, and **30 public `/insights` surfaces**.

**Bottom line for `CLAUDE.md`:** the go-live numbers barely moved — Top Shot is at/above its 50% bar on the new series (largely a denominator event), All Day sits just under 30% and is now proven liquidity-gated, and WAU is flat at 1 against a 50+ gate — but the week's substance was **operational, and two axes went the wrong way**: DB storage jumped 68% to 30.6 GB with a destructive-only reclaim path, and DB saturation spells returned for five straight days (M11). A **live trust breach** appeared (#82), the register **nearly doubled** in a heavy audit/ship week (`#0–#65` → `#0–#113`), the accuracy metrics finally became a **readable series**, and the **#22 purge branch was deleted** (residue still owed). The one thing gating all of it: the sandbox shell has been **dead six nights** (Sept-8 Windows update), so the autonomous pass has shipped 0 to prod and the working tree can only advance from Trevor's box or a push-capable path. **Demand is still the one number that decides everything.**
