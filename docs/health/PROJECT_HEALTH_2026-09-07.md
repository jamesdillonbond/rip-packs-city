# Rip Packs City — Project Health Report

**Date:** 2026-09-07
**Compiled by:** Claude (Cowork) — automated weekly run
**Sources:** `CLAUDE.md` + `docs/reference/known-issues.md` (Open § + STATUS INDEX, which now counts **64 numbered items — 33 open · 6 partial · 25 closed**, running `#0–#65`, current through the 2026-09-06 entries), `docs/reference/roadmap-status.md` (headline-metric block **re-read 2026-09-01 20:5x PT**), the **new** `docs/strategy/go-live-2026-09.md` (written 2026-09-06 with Trevor present — the M1–M11 go-live bars + B1–B5 blockers), `docs/audits/deep-audit-register.md` (**42 OPEN R-rows**; partial re-probe 2026-09-02) + `docs/audits/audit-2026-09-06-candy-and-panini-go-live-readiness.md`, `docs/overnight/metrics-latest.json` (captured **2026-09-07T08:05Z / 01:05 PT**, same day, genuine-overnight), `docs/overnight/ledger.md` (**1,714** live `### ` entries; newest heading 2026-09-07), `docs/overnight/inbox/` (**407 files; ops-note says 405 un-archived back to 2026-08-09**), plus a first-hand `git log` + `ripgrep` scan and file-existence verification (the workspace shell is **GREEN** this run).
**Scope:** A single consolidated, themed view of open work — the numbered known-issue slots (`#0–#65`), the go-live bars, the deep-audit register, the prioritized actions, the overnight operational queue, and the in-code TODO inventory — with suggested severity, effort, and a recommended sequence.
**Prior report:** `PROJECT_HEALTH_2026-08-31.md` (7 days ago). This regeneration mirrors its structure. `_2026-08-24.md` … `_2026-05-22.md` (eighteen prior reports) also live in `docs/health/`.

> **✅ Tooling note — shell GREEN, cloud git PUSH still dead, and now ROOT-CAUSED as immutable (`#55`).** Real `git`/`rg`/`wc` this run: measured commit counts, line counts, a first-hand TODO scan, and file-existence checks. ⚠ **`git push --dry-run origin main` = `could not read Username for 'https://github.com'`** — the cloud clone carries no push credential, so autonomous **code deploys from the cloud Cowork session remain blocked**. New this week: the cause is no longer "restore a credential" — `#55` (filed 08-31) shows the **2-hourly "RPC autonomous pass" Routine was created without `requires_local_device`, and that binding is IMMUTABLE**, so its cloud runs will never have a device bridge. The mitigation `.github/workflows/migration-autorecover.yml` recovers + commits fileless migrations 3×/day. **Trevor's box + Claude Code push normally** and did essentially all of this week's **~724 commits**. The 09-07 overnight pass shipped **0 to prod** (NO-PUSH; and it honestly notes no clean DB lever remained).

> **⚠ Date nuance.** The harness stamps today as **2026-09-07**; the freshest metrics were captured **08:05Z = 01:05 PT Sep 7** (no clock skew). The freshest **accuracy** read is **2026-09-01 20:5x PT** (`roadmap-status.md` headline block); the freshest **demand** read is **2026-09-06** (`go-live-2026-09.md` §1, from `auth.users`). Ledger/session dates in `CLAUDE.md` are Pacific. Filed under **2026-09-07** per the weekly-regeneration convention (prior report 08-31, exactly 7 days back).

> **Report location stays clean.** All nineteen reports (this one included) live in `docs/health/`; the repo root holds none.

> This is a snapshot. `CLAUDE.md` + `docs/reference/known-issues.md` are the source of truth for project memory; `docs/overnight/ledger.md` for what shipped; `docs/strategy/go-live-2026-09.md` for the go-live plan; `docs/audits/deep-audit-register.md` for the deep-audit findings. This doc reorganizes them for triage. **Severity and effort tags throughout are suggestions, not gospel.**

> **Biggest change since 2026-08-31 — Trevor DELEGATED the four standing "needs-Trevor" decisions and they were made and shipped, a go-live plan with hard numbers now exists, and the dead Top Shot feed is back.** Six threads. **(1) A firm go-live plan was written — `docs/strategy/go-live-2026-09.md` (2026-09-06, Trevor present).** It amends the accuracy-gate roadmap with **eleven measurable bars (M1–M11)** and **five blockers (B1–B5)**, each with the SQL/command to re-read it. This is the first time "through the gate" is expressed in numbers. **(2) Trevor delegated the four needs-Trevor items and they were DECIDED same day (09-06):** `#59` **wallet-verification gate DROPPED** (closed — history pages now gate on "saved," not a dead verification host), `#34` a **client-error beacon shipped** with its alert arm (partially closes the Sentry-dark blind spot — the money is still Trevor's call), `#63` **Candy MLB is LIVE (thin: overview only)**, `#64` **Panini decided = the WC Prizm plane** (bridge not started). **(3) The dead Top Shot public API is worked around — `#65`:** `public-api.nbatopshot.com` (decommissioned ~08-28) is replaced by Dapper's own **Atlas backend, read from the DB**, so the Sniper is serial-grain again and verification has a real seller-matched check. **(4) A 200-Moment Atlas audit (09-04) found Top Shot ask/badge/supply had been frozen ~a week and the FMV drain was lossy — 9.4% of every saved wallet's price stale;** a per-saved-wallet reconcile now runs every 30 min and its miss-rate is an instrument. **(5) The accuracy gate is FLAT-to-sliding:** estate-wide **35.1%** (09-01, was 34.9%), but **Top Shot slid to 37.3%** on the 09-06 go-live read (was 39.9% on 09-01 / 54.5% at its 08-13 peak) because the ask feeds were paused during the outage — the register is explicit this is drift, not progress. **(6) The register grew again** `#0–#54` → `#0–#65` (24 → **64** numbered items in the index; **33 open · 6 partial · 25 closed**).

> **Overnight reality — GREEN, and cleaner than last week; NO-PUSH (cloud).** The 09-07 genuine-overnight pass (01:05 PT) shipped **0** — shell GREEN, cloud push blocked (`#55`), and no clean DB lever remained. Security **0/0/0/0** (invariants, anon-write, rls-off, secdef-anon all clean). **Trust breaches: 0** (last week: 1 — the All Day unmapped-resolution backlog is no longer flagged as a breach, though the actionable backlog is now measured at **41,303**). **Stalled pipelines: 0.** `public_5xx_24h = 19` (**0 on boards**). Post-ship watch over the 09-06 ships (Candy live, verification drop, Atlas feed) was **holding** at close.

> **Traction reality — WAU slipped back to 1 (re-read 2026-09-06).** **24 accounts (+1), WAU 1 (was 2), MAU 5, 109 saved wallets (was 104)**, 0 email subscribers, 23 of 24 users have a saved wallet. The roadmap accuracy gate — share of prices at HIGH/MEDIUM confidence — stands at **35.1% estate-wide** (09-01). **Demand is still the one number that decides everything** — 1 WAU against a 50+ gate — and this week it ticked *down*, a reminder that n=1–2 is noise, not a trend. Per the roadmap, a low number is the *correct* output of a deliberately-unpromoted product; the go-live plan is explicit that marketing spend does not start until the M1–M9 bars read at the bar on the same day.

> **Cost / storage — UP SHARPLY this week.** DB is **18,191 MB, +4,750 MB** over last week's 13,441 (+35%). The two identified drivers: the **Atlas firehose ingest** (`ts_listings`/`cached_listings` rebuilt every ~2 min to restore the Sniper feed, `#65`) and **`wmc` index bloat regrowing ~64 MB/day** with no reindex job scheduled (`#56`). **Disk-IO on the SMALL (2 GB / 2-core) Supabase instance remains the binding operational constraint and is STRUCTURAL** (the 08-23 no-capacity decision holds). Separately, the **Vercel bill was 75% build compute** ($412/cycle) — the build machine was downgraded to Standard 4 vCPU + queued builds on 09-06 (`#61`), re-measure at the next invoice.

> **Platform context.** **(1) Top Shot's public REST API is DEAD** (`public-api.nbatopshot.com`, decommissioned ~08-28) — replaced by the Atlas backend read from the DB (`#65`). **(2) Flowty** frontend shut but API ALIVE and feeding live ingest. **(3) NFL All Day** primary pack sales ended; secondary-market only. **(4) UFC Strike** Flow market frozen (0 sales; honestly labelled). **(5) Candy / Solana — now LIVE, thin** (overview tab only, 09-06). **(6) Panini — decided = WC Prizm plane**; bridge not started, OpenSea plane is monitor-only. **(7) Expansions are readiness-gated, not sequence-gated.**

> **Operational reality — autonomous Cowork tasks.** `rpc-daytime-monitor` (read-only, ~every 3h) and the nightly pass run against this repo; shared state is in `docs/overnight/` (`ledger.md` — **1,714** live entries, `inbox/` — **407 files** with **405 un-archived**, `metrics-latest.json`, `focus.md`, `.lock`). `docs/FREEZE.md` (absent this run → no freeze) halts all autonomous shipping. **Check `docs/overnight/ledger.md` and `docs/reference/known-issues.md` before acting** — much of this week's work landed from Claude Code / device-VM Cowork on Trevor's box, not the cloud pass, so the tree may be ahead of this snapshot.

---

## 1. At a glance

| Bucket | Count | Notes |
|---|---|---|
| Known-issue slots tracked | **#0–#65** | Register STATUS INDEX: **64 numbered items — 33 open · 6 partial · 25 closed**. Eleven new slots (#55–#65) since last week's `#0–#54`. See §9. |
| Known issues — resolved/closed since last week | **~4** | **#47** (candy-editions kills — falsifier answered, kills stopped), **#57** (PostgREST-cap sweep — all 19 candidates triaged, 4 fixed/15 refuted), **#59** (verification gate dropped), plus **#34** partially closed (client-error beacon shipped). — §6 / §9 |
| Known issues — open / partial | **~39** | 33 open + 6 partial per the index (incl. new #55, #56, #58, #60, #61, #62, #63, #64, #65). — §3 / §9 |
| Known issues — 🚨 SECURITY, needs Trevor | **1** | **#22** — the 2026-08-03 credential purge remains DEFEATED by a stale ROOT-branch of the PUBLIC repo (`claude/todo-implementation-e4tib3`); pre-purge blob still fetchable. Triage `ee94c8a2a`, delete via GitHub UI, GC, rotate regardless. Unchanged. — §2.4 |
| Known issues — instrument, needs Trevor | **2** | **#34** — Sentry dark since 08-18; **PARTIALLY MITIGATED 09-06** by a `window.onerror`→`/api/telemetry` beacon (M7 met), Sentry spend still Trevor's call. **#58** — `OPENSEA_API_KEY` unset (now **moot** under the #64 Panini decision unless the OpenSea plane is revisited). — §2.5 |
| Known issues — needs Trevor, one machine | **1** | **#55** — the 2-hourly autonomous Routine runs CLOUD-ONLY and cannot push; the binding is **immutable**, so the fix is to recreate the Routine with `requires_local_device` on Trevor's box. — §2.6 |
| Known issues — regressed / measured-dead (carried) | **1** | **#8 sports-proxy 403** — still measured dead; suppressed to 2026-10-14; deferred to preseason (~Oct). — §2.3 |
| Known issues — removed from the tree by decision | 3 | #1 Cart, #3 Trade Hub, #3b Gifting — DELETED (read-only pivot). Verified still absent. |
| **Go-live plan (NEW 2026-09-06)** | **M1–M11 + B1–B5** | `docs/strategy/go-live-2026-09.md` — eleven measurable bars, five blockers, with the read for each. — §2.1 |
| Commits since last report | **~724** | Measured (`git log --since 2026-08-31`): 41 (31st) · 78 (1st) · 176 (2nd) · 144 (3rd) · 120 (4th) · 112 (5th) · 53 (6th) · 0 (7th). HEAD `7f4146e17` (2026-09-06 19:40 PT, a honesty fix on the closed-market ticker). |
| Accuracy gate (headline metric) | **35.1% estate-wide** | 09-01 read; up +0.2 pt from 34.9% (drift, not progress — register is explicit). TS **39.9%** (09-01) but the 09-06 go-live read has it at **37.3%** and sliding as ask feeds stay paused. AllDay 25.4% / Golazos 0.3% / UFC 0.0% / Candy 63.2%. |
| Demand (the critical-path number) | **WAU 1 · 24 accounts · 109 saved wallets** | 09-06 read. WAU slipped from 2 → 1 (n=1 is noise). MAU 5. Gate: **50+ WAU**. — §2.1 |
| Open overnight operational items | **~9 active + standing queue** | NO-PUSH (cloud, #55); wmc index bloat + no reindex job (#56); DB +4.75 GB (Atlas ingest + bloat); Vercel build-compute (#61); #22 credential purge (operator); #8 sports-proxy 403 (operator, ~Oct); pg_cron waste (#40–#43). — §2.6 |
| Net-new structural workstream | 2 live | Candy/Solana **now LIVE thin** (09-06) + Panini (decided = WC Prizm, bridge pending). — §2.8 |
| Prioritized next actions | **superseded** | `docs/strategy/roadmap-2026-08-03.md` (accuracy-is-the-gate) + the new `go-live-2026-09.md` (the numbers). Gate: **50+ WAU**. See §4. |
| In-code TODO markers | **0 actionable in live app code** (+2 candy launch-flag "note" branches by design, +6 solana readiness-guard refs, +draft-doc `RESOLVED`/`CLOSED` lines, +1 migration comment, +a few resolved-narrative false positives) | Measured via `ripgrep` — §5 |
| Test / DB-invariant pins | **188 `supabase/tests/*.sql` files** | +7 vs last week's 181. Live pin sweep not re-run this pass. |
| CI jobs (ci.yml) | **18** | Added `inbox-guard`, `unit-tests-shard`, `workers-typecheck`, `memory-docs`, `docs-tests` vs last week's reported 12; plus the `changes` path-filter. |
| Active revenue-blocking items | 0 | By decision — monetization tabled until 50+ WAU |

**Health read:** A heavy, *decision-dense* week (~724 commits) shipped almost entirely from Trevor's box while the cloud pass stayed read-only under the now-immutable NO-PUSH (`#55`). The substance was not new metrics — the accuracy gate is flat-to-sliding (estate-wide 35.1%, Top Shot down to 37.3% as ask feeds stay paused) and WAU actually *slipped* to 1 — but a **cluster of long-standing decisions Trevor finally delegated and that were made and shipped in one 09-06 session**: verification's dead gate dropped (`#59`), a free client-error beacon to cover the Sentry blind spot (`#34`), Candy MLB flipped live in thin form (`#63`), and Panini's identity settled on the WC Prizm plane (`#64`). Behind them sits the week's biggest engineering save — **the Top Shot feed restored from Dapper's Atlas backend** (`#65`) after `public-api.nbatopshot.com` was decommissioned — and its side effect, a **+4.75 GB DB jump** from the 2-minute Atlas firehose plus `wmc` index bloat with no reindex job (`#56`). The new **`go-live-2026-09.md`** is the most useful artifact of the week: it turns "through the accuracy gate" into eleven readable bars. Descending, concentrated risk: **(1) demand** — WAU 1 against a 50+ gate, still the whole ballgame, and it went the wrong way; **(2) Top Shot accuracy sliding** — 37.3% vs a 50% go-live bar while the ask feeds are paused (the Atlas ingest is the fix and is the concurrent track); **(3) cost drift** — DB +35% in a week, Vercel 75% build compute (mitigations applied, unverified); **(4) the standing operator items** — the credential purge (`#22`), Sentry money (`#34`), the cloud NO-PUSH binding (`#55`).

### Themes

| Theme | Items |
|---|---|
| **Launch / activation (the whole critical path)** | Public since 07-17; self-serve since 07-20. **Re-measured 2026-09-06: WAU 1 / 24 accounts / 109 saved wallets.** Accuracy gate 35.1%. The go-live plan now names the numbers. The problem is *demand*. Gate: **50+ WAU** (§2.1) |
| **Go-live plan written (NEW)** | `go-live-2026-09.md` — M1–M11 bars, B1–B5 blockers, each with its read. Marketing spend gated on M1–M9 reading at the bar the same day (§2.1) |
| **Delegated decisions shipped (the week's substance)** | #59 verification gate dropped · #34 client-error beacon + alert arm · #63 Candy MLB live (thin) · #64 Panini = WC Prizm — all 09-06, Trevor delegating (§2.3 / §2.8) |
| **Top Shot feed restored from Atlas (#65)** | `public-api.nbatopshot.com` dead ~08-28; replaced by Dapper's Atlas backend read from the DB; Sniper serial-grain again; verification seller-matched (§2.3) |
| Data-intelligence correctness / honesty | 200-Moment Atlas audit (09-04): TS ask/badge/supply frozen ~a week, FMV drain lossy 9.4% → per-saved-wallet reconcile; Top Movers published STALE re-pricings as +2,892% gainers → sales-backed definition; onboarding-walk honesty fixes (§2.3) |
| **Accuracy gate flat-to-sliding** | Estate-wide 34.9% → **35.1%** (drift); **Top Shot 39.9% → 37.3%** as ask feeds stay paused during the outage; the levers are sales-density + ask-corroboration, not pipeline reliability (§2.3) |
| **Cost / storage UP** | DB **18,191 MB, +4.75 GB** (Atlas firehose + wmc bloat #56); Vercel bill 75% build compute → downgraded to Standard (#61). Disk-IO saturation STRUCTURAL (§2.6) |
| Structural saturation (decided, itemized) | pg_cron waste cluster (#40–#43) carried; the wmc reindex cadence (#56) is now a rate-backed decision, not a judgement (§2.6) |
| Instrument darkness / operator-owned | #34 Sentry dark since 08-18 (beacon shipped 09-06 as mitigation); #22 defeated credential purge; #55 cloud NO-PUSH binding immutable; #62 a **new** true-mobile QA instrument now exists (§2.4 / §2.5) |
| Security | **0/0/0/0** invariants; a 09-06 CISO grant-tightening pass (#60 — can't revoke anon from net/cron schemas, needs Supabase support). Standing debt is **#22** (§2.4) |
| Product simplification — READ-ONLY pivot | Cart / Trade Hub / Gifting **DELETED** — verified still absent (§2.9) |
| Chain expansion — Candy LIVE, Panini decided | Candy `/candy-mlb/overview` LIVE thin (09-06); Panini = WC Prizm plane, bridge pending (§2.8) |
| Tech debt / refactor | Monoliths grew: DashboardClient **2,836** / CollectionAnalyticsClient **1,875** / SniperClient **1,849** / CollectionTabClient **1,416** / MarketClient **1,199** (measured this run) (§3) |
| Deferred hardening (intentional) | Public INSERT-policy tables; `owner_key`→`user_id`; Golazos `highest_offer` gap (settled: no offer source exists — do not build the indexer) |

---

## 2. Critical path — start here

Go-live is **operationally done** (public + self-serve). The forward plan is now two layers: **`docs/strategy/roadmap-2026-08-03.md`** (accuracy is the GATE, not a phase — headline metric is the HIGH/MEDIUM confidence share) and the **new `docs/strategy/go-live-2026-09.md`** (what "through the gate" means in numbers: M1–M11 bars, B1–B5 blockers). The only user gate remains **50+ WAU**.

### 2.1 Launch + activation — the plan now has numbers; demand slipped — `Severity: High · Effort: Medium (built + measured, needs traffic)`

The un-gate shipped 07-17; self-serve magic-link signup opened 07-20. Read-only tabs are anonymous for the 5 published Flow collections (now +Candy overview); cost-basis/P&L, saved wallets, watchlist, `/dashboard/*`, and every mutation stay behind sign-in.

- **Traction re-read 2026-09-06:** **24 total accounts (+1 in a week), WAU 1 (was 2), MAU 5, 109 saved wallets**, 0 email subscribers, 23 of 24 users have a saved wallet. **WAU went the wrong way** — but n=1–2 is noise, not a trend. The **roadmap accuracy gate is 35.1% HIGH/MEDIUM** estate-wide (09-01, +0.2 pt = drift).
- **The go-live plan (`go-live-2026-09.md`, 09-06) is the new artifact.** It defines eleven bars — M1 Top Shot ≥50% HIGH/MEDIUM with Atlas live (today 37.3%), M2 All Day ≥30% (24.1%), M3 zero fabricated-number surfaces on the new-user walk (**met 09-06**), M4 cold Collection-tab first-row ≤8 s on a 15K wallet (today 15–25 s), M7 a client-error detector that has caught a synthetic error (**met 09-06**), M9 verification mechanism-or-gate-gone (**gate gone 09-06**) — and states marketing spend starts only when **M1–M9 read at the bar on the same day, from the same instruments**.

Suggested next step: land the Atlas ask feed to lift M1 back toward 50%, close B4 (cold-path latency, measured by BUFFERS), then pick **one** acquisition channel and run it against the 50+ WAU gate. Still the single most important item in the whole report.

### 2.2 Public intelligence surfaces — 30 public — `Severity: n/a (shipped) · context`

All 30 built surface dirs in `app/insights/` are public. Candy's board is joined this week by a **live Candy `/candy-mlb/overview` collection tab** (thin — overview only). Carried honesty risks: `#50` (`/insights/pack-reality` "Honest +EV ranker" draining while both catching arms read greener), `#33` (ISR bakes a failed read into the whole `revalidate` window). Some boards continue to serve last-good snapshots under saturation, surfaced honestly with an age stamp.

### 2.3 Data-intelligence — the Atlas save, an audit, accuracy sliding — `Severity: Medium (green; operator items) · Effort: mixed`

**FMV HIGH/MEDIUM confidence share:** estate-wide **35.1%** (09-01). Per-collection (09-01): **Top Shot 39.9%**, **All Day 25.4%**, **Golazos 0.3%**, **UFC 0.0%**, **Candy 63.2%**, Pinnacle 45.0% (separate leg). ⚠ **The 09-06 go-live read has Top Shot at 37.3% and falling** — it peaked at 54.5% on 08-13 and has given back a third because the ask-refresh feeds were paused through the `public-api.nbatopshot.com` outage. The register is explicit: estate-wide +0.2 pt over 3.5 days **is drift, not progress**, and nothing shipped 08-31/09-01 was aimed at this metric.

**Shipped since last week (mostly from Claude Code / device-VM Cowork on Trevor's box):**

- **`#65` — the Top Shot feed is BACK, from Dapper's Atlas backend, read from the DB (09-06).** `public-api.nbatopshot.com` (the REST host verification and some reads used) was decommissioned ~08-28; the replacement reads `api.production.atlas.dapperlabs.com` into `ts_listings`/`cached_listings`/`edition_offers.low_ask`, rebuilt every ~2 min. **The Sniper is serial-grain again**, and verification now has a real seller-matched check (this wallet, this Moment, this price). Side effect: the 2-min firehose is a driver of the DB size jump.
- **`#59` — wallet verification gate DROPPED (09-06).** Verification read the dead host and told every new user "No matching listing found" (a false claim about their own account). Pack/Transaction History now gate on "saved wallet" (public on-chain data — the gate protected only a label). Option (b), a real "verified" badge via an Atlas listing challenge, landed the same evening.
- **`#34` — a client-error beacon shipped (09-06).** `ClientErrorBeacon.tsx` (mounted in `app/layout.tsx`) sends `window.onerror`/`unhandledrejection` to `/api/telemetry`, bounded and deduped; an alert arm fires on it. **M7 met** (synthetic throw → 1 prod row). It does not restore Sentry — the money is still Trevor's call — but the client-only blind spot is no longer total.
- **200-Moment Atlas audit (09-04) — 4 migrations + code.** Found every Top Shot ask/badge/supply number RPC shows had been **frozen ~a week**, 67,607 parallel Moments were priced as their Standard, and the FMV drain was **lossy: 9.4% of every saved wallet's FMV rows disagreed with the edition's current price**. A per-saved-wallet reconcile now runs `6,36 * * * *` (`cron_heavy`), driving from each wallet's own rows and logging its fix count — **the drain's miss rate is now an instrument.**
- **Top Movers stale re-pricing FIXED (09-03/04).** The public profile's Top Movers published STALE cold-tail re-pricings as gains (LeBron +141.5%, Zion +372%, Carmelo **+2,892%**). A mover's current price must now be sales-backed AND have ≥1 sale in the window; cost is not worse (the `EXISTS` semi-join runs before the lateral).
- **Onboarding / trophy-case QA drains (09-02/03/04).** Multiple honesty fixes found by signing up fresh accounts and walking the collector path: empty-case share button, "build your own" shown to an owner, a header link pointing to a wallet search for a collector who doesn't exist, a breakdown reading 2× its headline.

**Carried / open:**

- **pg_cron waste cluster `#40`–`#43`** (22.6% of cron time wasted to schedule alignment; 48 inert `statement_timeout` decls). Carried from run 4; no re-stagger shipped.
- **`#8` — sports-proxy `403` remains MEASURED DEAD** as a "proxy ESPN" fix. ESPN 403s residentially too; alarm suppressed to 2026-10-14; projections deferred to preseason (~Oct). Operator-only.
- **FMV dust-filter sale-floor decision** (`docs/fmv-dust-filter-decision-2026-08-02.md`) — analysis-only, hand-off-only. Still the highest-leverage accuracy-gate correctness change queued behind Trevor.

### 2.4 Security, confidentiality + test infrastructure — `Severity: Medium (green; 1 operator P0) · Effort: landed`

- **Security posture GREEN.** `metrics-latest.json`: **0/0/0/0** — invariants, anon-write holes, rls-off base tables, secdef-anon drift all clean (re-verified live 09-07).
- **A 09-06 CISO grant-tightening pass ran** (`20260906170542` took TRUNCATE/REFERENCES/TRIGGER off every public relation for anon+authenticated and INSERT/UPDATE/DELETE off anon except the five write-by-design tables). It surfaced **`#60` — Postgres cannot revoke `anon`/`authenticated` from the `net`/`cron` schemas** (those grants are `supabase_admin`'s; `postgres` gets `permission denied`). Exposure is theoretical today (no SECDEF wrapper calls `net.http_get`; `check_secdef_anon_exec_drift()` = 0), but every new SECDEF function is one grant from an SSRF primitive. Real fix needs Supabase support; the security subagent rated it M1, no CRITICAL.
- **🚨 `#22` — the 2026-08-03 credential purge remains DEFEATED (operator, needs Trevor).** `origin/claude/todo-implementation-e4tib3` branches from the ROOT commit, was never rewritten, and still carries the pre-purge blob on the **public** repo. Honest "ahead" figure: **one** draft commit (`ee94c8a2a`). Ordered fix: triage that commit → delete the branch **via the GitHub UI** (remote delete-ref 403s from the sandbox) → ask GitHub to GC → **rotate regardless**. Unchanged since last week; carried in the go-live plan as B5.
- **DB-invariant SQL layer: 188 `supabase/tests/*.sql` files** (+7). CI is **18 jobs** in `ci.yml` (added `inbox-guard`, `unit-tests-shard`, `workers-typecheck`, `memory-docs`, `docs-tests`). **Never lower thresholds to green a build.**

### 2.5 Automation / asset hygiene — `Severity: Low–Medium · Effort: ongoing`

The cloud pass is queue-only when it cannot push (this run). **Hygiene state:** `docs/overnight/ledger.md` holds **1,714** live entries; `docs/overnight/inbox/` holds **407 files** with **405 un-archived back to 2026-08-09** — archival needs a push-capable pass. ⚠ **`#34` — Sentry dark since 2026-08-18** (org quota); **mitigated 09-06** by the client-error beacon (M7 met), but full client-error capture still depends on Trevor's Sentry-spend call. ⭐ **`#62` — true-mobile QA now has a real instrument:** `scripts/qa/mobile-sweep.mjs` (real Chromium at 390×844 from the device VM). Until 09-06, "mobile QA" was the Cowork extension window, which bottoms out at ~738 px — every sub-420 claim before that date was a desktop layout squinted at.

### 2.6 Overnight operational queue — `Severity: Low–Medium · Effort: mixed`

Health is GREEN, cleaner than last week (0 trust breaches, 0 stalled pipelines). Open items:

| Item | Issue | Severity | Notes |
|---|---|---|---|
| **NO-PUSH — now immutable (#55)** | The 2-hourly autonomous Routine was created without `requires_local_device`; that binding **cannot be edited**, so cloud runs never get a push credential. Migrations reach prod fileless. | **Med (operator)** | Recreate the Routine on Trevor's box with the device flag; `.github/workflows/migration-autorecover.yml` recovers fileless migrations 3×/day as the MOP. |
| **DB +4.75 GB in a week (#56 + #65)** | 13,441 → **18,191 MB**. Drivers: the 2-min Atlas firehose (#65) and `wmc` index bloat regrowing **~64 MB/day** with **no reindex job scheduled** (`wmc-reindex-verify` is a permanently-red instrument). | Med (structural) | Book a REINDEX cadence — a reindex buys ~1 week; the rate makes it a decision, not a judgement. |
| **Vercel bill 75% build compute (#61)** | $412/cycle, 2,034 deployments / 906 builds on a Turbo build machine. Downgraded 09-06 to Standard 4 vCPU + queued builds. | Med | Re-measure at the next invoice; further levers: push rate, wallet-backfill idle cadence, Observability Plus. |
| **pg_cron waste cluster (#40–#43)** | 22.6% of cron time wasted (schedule alignment); 48 inert `statement_timeout` decls; market-index-daily 21.1% fail. | Med (structural) | Re-stagger / tune; do NOT upgrade the tier. |
| **#8 sports-proxy 403** | ESPN/NBA/DK all 403; proxy-ESPN measured dead; alarm suppressed to 2026-10-14. | Med (operator, deferred) | Do NOT retire (sole writer for `nba_players`/projections). |
| **#22 credential purge** | Stale public branch still carries the pre-purge blob. | **P0 (operator)** | GitHub-UI delete + GC + rotate. |
| **#34 Sentry dark** | No client-error capture beyond the new beacon + E2E DOM smoke. | Med (operator) | Trevor: Sentry spend vs the beacon (shipped). |

### 2.7 Pack EV / pack-viz — `Severity: Low (honest by construction) · Effort: landed`

Carried. Pack-EV surfaces label rows for packs nobody can buy and disclose AllDay/Golazos EV as an original-supply model; Candy leads with Typical-Pull median. The `compute-*-pack-ev` edge functions are in the drifted set (operator-gated redeploy, `#23`).

### 2.8 Chain foundation — Candy LIVE, Panini decided — `Severity: Low (shipped) · Effort: landed`

- **Candy / Solana — now LIVE, THIN (2026-09-06, `#63`):** `published: true`, `pages: ["overview"]`, `collections.is_active = true`. The overview tab shows real KPIs from `get_collection_stats('candy_mlb')`; nav/switcher/footer entries added; footer badge "BUILT ON FLOW + SOLANA". **No Collection/Packs/Sniper tabs yet** (Flow-dispatched components with zero Solana arms). The flip found and fixed a trap: `published` had been standing in for "Flow" in five fan-outs, each now filtered to `dbChain === "flow"`.
- **Panini — DECIDED = the WC Prizm plane (2026-09-06, `#64`):** the plane with data (4,910 `panini_editions`, 46K FMV rows, the squeeze board) over the OpenSea `paniniblockchain` registry (0 editions). The hardcoded `PANINI_NEWS` block was deleted from the bridge overview. **Bridge NOT started** (1–2 weeks: map side tables → `editions`/`fmv_snapshots` with the 36.2% coverage disclosure). `#58` (`OPENSEA_API_KEY`) is now **moot** under this decision.
- **Chain-abstraction Phases A–F complete;** re-export shims deleted 07-25. **17 Cloudflare worker dirs** (verified).

### 2.9 Read-only product pivot — carried, verified still in effect — `Severity: n/a (landed) · Effort: (done)`

Cart, Trade Hub, and Gifting remain **deleted from the tree** — verified this run: `lib/cart/`, `lib/trade-escrow/`, `app/dashboard/{trade-hub,gift}/` all **absent**. The product is purely read-only.

---

## 3. Known issues — by theme

Severity/effort are suggestions. "#" = the item number in `docs/reference/known-issues.md`. **§9 has the verified open/resolved status of every numbered item.**

### Launch / activation (the whole critical path)

| # | Issue | Severity | Effort |
|---|---|---|---|
| — | **Traffic / WAU.** Public + self-serve ~7.5 weeks; **re-measured WAU 1 / 24 accounts / 109 saved wallets (2026-09-06)** — slipped from 2. Accuracy gate 35.1%. Gate: **50+ WAU**. | **High** | Medium (assets built, channel unrun) |
| — | **Go-live bars M1–M11** (`go-live-2026-09.md`). Met: M3, M7, M9. Below bar: M1 (37.3% vs 50%), M2 (24.1% vs 30%), M4 (15–25 s cold vs ≤8 s), M10 (build compute). | High | Mixed |

### Cost / storage (NEW pressure)

| # | Issue | Severity | Effort |
|---|---|---|---|
| 56 | `wmc` index bloat regrows ~64 MB/day; `wmc-reindex-verify` permanently red; **no reindex job scheduled**. A REINDEX buys ~1 week. | Med | Small (book a cadence) — a decision, not a diagnosis |
| 61 | Vercel bill 75% build compute ($412/cycle); downgraded to Standard 09-06. | Med | Re-measure at invoice; further levers open |
| 65 (side-effect) | The 2-min Atlas firehose is a driver of the +4.75 GB DB jump. | Low–Med | Monitor; part of the accuracy fix |

### Structural saturation / pg_cron waste

| # | Issue | Severity | Effort |
|---|---|---|---|
| 42 | 22.6% of all pg_cron time thrown away, 85.2% statement timeouts, schedule alignment. | Med | Medium (re-stagger + tune) |
| 43 | 48 active pg_cron jobs declare a `statement_timeout` with NO EFFECT. | Med | Medium |
| 41 | jobid 235 `rpc-refresh-market-index-daily` fails 21.1% on an outgrown budget. | Low–Med | Small |
| 40 | Candy listings sweep FIXED but visibly TRUNCATED. | Med | Medium |
| 52 | Hot `LANGUAGE sql` RPCs plan PARAM-BLIND on PG 17. Two headline reads fixed; class sweep part-done. | Med (partial) | Medium |

### Data-intelligence correctness / honesty

| Item | Issue | Severity | Effort |
|---|---|---|---|
| FMV confidence | Estate-wide 35.1%; **Top Shot sliding 39.9% → 37.3%** as ask feeds stay paused. Golazos 0.3% / UFC 0.0% remain floors. | Medium | Ongoing (Atlas feed) |
| 50 | `/insights/pack-reality` "Honest +EV ranker" draining to empty; both catching arms read greener. | Medium (open) | Small–Medium |
| 39 | Public `/insights/underpriced-serials` API 503s, mean ~5,092 ms — a judgement fix (Trevor). | Medium (Trevor) | Medium |
| 33 | ISR bakes a failed read into the whole `revalidate` window; `/insights/pack-drops` no stale fallback. | Medium (Trevor) | Small–Medium |
| FMV dust-filter | `$0.50` sale floor inflates ~46% TS / ~76% AllDay editions. Decision doc queued — hand-off-only, Trevor's call. | Medium | Small (decision) / medium (unwind) |

### Instruments / edge-function drift / operator

| # | Issue | Severity | Effort |
|---|---|---|---|
| 55 | 2-hourly autonomous Routine is cloud-only, cannot push; binding immutable. | Med (operator) | Small (recreate Routine on device) |
| 34 | Sentry dark since 08-18; **mitigated 09-06** by the client-error beacon; full capture needs Trevor's spend call. | Med (operator) | Trivial (billing) / shipped (beacon) |
| 60 | Postgres cannot revoke anon/authenticated from `net`/`cron` schemas; needs Supabase support. | Low–Med (operator) | External |
| 62 | True-mobile QA instrument now EXISTS (`mobile-sweep.mjs`, 390 px real Chromium). | Low (instrument) | (landed) |
| 31 / 23 / 53 | Edge-fn drift: authoritative arm; real drift 25; sentinel red-by-design (6 must NOT redeploy). | Med (operator) | Medium |
| 25 | Detector-Health arm inactive until `GITHUB_ACTIONS_READ_TOKEN` set in Vercel env. | Low (operator) | Trivial (one env var) |
| 58 | `OPENSEA_API_KEY` unset → 2 Panini surfaces 502. **Moot** under the #64 WC-Prizm decision. | Low (moot) | Trivial if revisited |

### Tech debt / refactor

| # | Issue | Severity | Effort |
|---|---|---|---|
| 14 | Monolith page refactor — Phase 1 done; bulk in DashboardClient **2,836** / CollectionAnalyticsClient **1,875** / SniperClient **1,849** / CollectionTabClient **1,416** / MarketClient **1,199** (measured this run — all grew). Phase-2 splits remain. | Low–Medium | Large |
| 10 | `/dashboard` token migration — logic in `DashboardClient.tsx` (**2,836** lines). | Low | Large |

### Page polish

| # | Issue | Severity | Effort |
|---|---|---|---|
| 17 | Pack/Moment/Set tune-up. Lower-value tier. | Low–Medium | Medium (mostly done) |
| 11 | Brand punch list — named remaining item is a ghost. CI guard `check-brand-tokens.mjs` present. | Low | Small |
| 12 | Blazers trivia — CLOSED; file `lib/blazers-trivia.ts` verified ABSENT this run. | Low (closed) | Trivial |

### Stalled / scaffolded features

| Item | Issue | Severity | Effort |
|---|---|---|---|
| #1 / #3 / #3b | Cart / Trade Hub / Gifting — DELETED, verified still absent. | n/a (removed) | n/a |
| — | Breaks — dormant (tables not in prod, migration unapplied). | Low (dormant) | n/a |

### Deferred hardening (intentional)

- `email_subscribers`, `outbound_clicks`, `portfolio_snapshots`, `support_conversations` retain `roles=public` INSERT policies. Future: per-row size caps, `created_at` rate-limit trigger, `bot_score`, possibly an edge rate-limiter.
- `user_achievements` + `watchlist_items` — service-role-only writes, still keyed on `owner_key` (text) not `user_id` (UUID).
- `badge_editions.low_ask` — AllDay + Golazos RESOLVED. Golazos `highest_offer` gap is SETTLED: **no Golazos offer source exists** (0 DapperOffersV2 offers). **Do NOT schedule the staged offers indexer** — it would index nothing.

### Architecture notes worth tracking

- **Two "collection vocabulary" and two "confidence vocabulary" footguns** persist by design. Re-read `CLAUDE.md` before any new query.
- **Supabase compute is `SMALL` (2 GB / 2-core)** — saturation is disk-IO-bound and STRUCTURAL. The DB is now **18.2 GB and rose 35% this week**; the Atlas firehose and wmc bloat are the drivers.
- **A function-level `SET statement_timeout` is INERT on pg_cron** (`#43`).
- **Eight caller sources** — including a Windows Scheduled Task on Trevor's box (four prod ingests) and cron-job.org — are invisible to a repo grep. Enumerate all before calling any ingest dead.

---

## 4. Prioritized next actions — **superseded**

`CLAUDE.md`'s old two-item list is replaced by **`docs/strategy/roadmap-2026-08-03.md`** (accuracy-is-the-gate) and, new this week, **`docs/strategy/go-live-2026-09.md`** (the numbers):

| Phase | Action | Status |
|---|---|---|
| Gate | **Accuracy is the GATE — HIGH/MEDIUM share must beat incumbents.** | **Flat-to-sliding — estate-wide 34.9% → 35.1% (drift); Top Shot 39.9% → 37.3% as ask feeds stay paused. The Atlas ingest is the fix.** |
| Go-live | **M1–M11 bars now defined.** | Met: M3, M7, M9. Below bar: M1, M2, M4, M10. Marketing spend gated on M1–M9 same-day. |
| 1 | **Prove the product with real users — 50+ WAU.** | **Open — the critical path. WAU slipped 2 → 1 (2026-09-06).** |
| 2 | Cost / latency levers. | **New pressure — DB +4.75 GB, Vercel 75% build compute (mitigations applied, unverified).** |
| 3 | Durable debt. | Heavy advance — 200-Moment Atlas audit, Top Movers fix, verification drop, beacon. |
| 4 | Chain two, readiness-gated. | **Candy LIVE (thin, 09-06); Panini decided = WC Prizm (bridge pending).** |

**Standing guardrails:** no paywall/Stripe until 50+ WAU; no infra spend pre-revenue; **verify pages by rendered DOM, not HTTP 200**; **before gating/short-circuiting any route, enumerate EVERY caller** (eight sources).

**Housekeeping still outstanding:** action the credential-purge cleanup (#22); recreate the autonomous Routine on-device (#55); book a wmc REINDEX cadence (#56); set `GITHUB_ACTIONS_READ_TOKEN` (#25); land the Atlas ask feed to lift M1.

---

## 5. In-code TODO inventory

A first-hand `ripgrep` scan over `app/ lib/ components/ workers/ supabase/functions/ scripts/ docs/drafts/ proxy.ts` (node_modules/.next/.git excluded) found **no actionable markers in live application code** — unchanged in character from prior weeks. Breakdown:

### 5a. Candy launch-flag-gated "note" branches (2 markers) — keep by design

- `app/api/ingest/candy-editions/route.ts:182` and `app/api/candy-sales-indexer/route.ts:195` — `note: "…still a TODO_-prefixed placeholder"` strings inside launch-flag-gated defensive branches. Constants are filled (Candy is now live); branches unreachable in practice. Not actionable.

### 5b. Solana readiness-guard refs (6 markers) — guard functions, not open work

- `lib/chains/solana/normalize.ts` — the `startsWith("TODO_")` readiness-guard functions (lines 360/364) + their `TODO_3/4/5 RESOLVED` narrative (lines 46/54/59/150/355). Placeholder-guards, not open TODOs.

### 5c. Panini draft/reference lines — draft-only, all closed

- `docs/drafts/panini/ingest-panini-runner.mjs` (`TODO(go-live) RESOLVED 2026-07-16/19`, plus one enumeration back-reference) and `docs/drafts/panini/panini-proxy/index.js:19` (`TODO(discovery) CLOSED 2026-07-19`) — annotated resolved/closed draft scaffolding.

### 5d. Narrative / false positives (rest)

- `lib/rtr-lock-roi-weights.ts:7` + `app/api/rtr/lock-roi/route.ts:38` ("resolves the standing … TODO" / "v2 folds in the two signals the v1 TODO called out"), `lib/format.ts:6` (a `"$X,XXX.XX"` format doc). All describe *resolved* work.
- ⚠ **Method note:** a whole-repo `grep -r` over the large SQL corpus times out (documented in prior reports). `ripgrep` with negated globs scoped to source dirs returned promptly and is the basis here. The `workers/**/node_modules/` tree contains vendored TODO markers — excluded as third-party.

> **Net change since last week:** none of consequence. Live application code has zero actionable TODO markers. (Only line-number drift: the candy-sales-indexer note moved 185 → 195.)

---

## 6. Resolved / no action needed

Verified against the codebase, `docs/reference/known-issues.md`, and `docs/overnight/metrics-latest.json`:

**Known-issue slate (carried, still resolved):** #0 (wallet verification, resolved-by-removal), #1/#3/#3b (Cart/Trade Hub/Gifting, deleted), #4 (Pinnacle FMV), #5, #7, #9, #12 (file absent), #13, #15, #16, #19, #24, #28 (sitemap truncation), #37 (React #418), #44, #45, #46, #53. ⚠ **#8 remains REGRESSED / measured-dead** — see §2.3/§9.

**Newly resolved / closed / mitigated since last week:**
- **#47 candy-editions kills** — CLOSED 09-01; the experiment's falsifier is answered (kills stopped).
- **#57 PostgREST-cap sweep** — RESOLVED 09-02; all 19 candidates triaged (4 confirmed and fixed, 15 refuted — a static query-chain scan has ~20% precision on this codebase).
- **#59 wallet verification** — RESOLVED 09-06 (gate dropped; Atlas seller-matched check added).
- **#34 Sentry blind spot** — PARTIALLY mitigated 09-06 (client-error beacon + alert arm; M7 met). Sentry spend still open.
- **#63 Candy MLB** — SHIPPED LIVE (thin) 09-06.
- **#64 Panini** — DECIDED 09-06 (= WC Prizm plane).
- **#65 Top Shot feed** — restored via Atlas 09-06.

---

## 7. Suggested sequence

A pragmatic order under **accuracy-is-the-gate** + the new go-live bars:

1. **Land the Atlas ask feed to lift M1 (Top Shot HIGH/MEDIUM) back toward 50%.** The single highest-leverage accuracy item — Top Shot is sliding (37.3%) only because the ask feeds are paused, and the Atlas ingest is the fix and already the concurrent track.
2. **Action the standing operator items — Trevor.** (a) **#22** credential purge (triage `ee94c8a2a`, GitHub-UI delete, GC, rotate). (b) **#55** recreate the autonomous Routine on-device with `requires_local_device` to end the cloud NO-PUSH. (c) **#34** decide Sentry spend vs the shipped beacon. (d) **#25** set `GITHUB_ACTIONS_READ_TOKEN`.
3. **Book a wmc REINDEX cadence (#56)** — the bloat rate (~64 MB/day, a REINDEX buys ~1 week) turns this from a judgement into a decision; it is a driver of the +4.75 GB DB jump.
4. **Close B4 — cold Collection-tab latency (15–25 s → ≤8 s)** on a 15K wallet, measured by BUFFERS on the page-1 read plus parallelising the client's follow-up fetches.
5. **Drive traffic against the 50+ WAU gate (§2.1).** WAU slipped to 1; the go-live plan says spend starts only when M1–M9 read at the bar the same day. Pick one channel.
6. **Attack the pg_cron-waste cluster (#42 → #43 → #41 → #40)** — a re-stagger, not a capacity buy.
7. **Fix #50 (pack-reality ranker) and #33 (ISR bakes a failed read)** — live instances of the house "failed read renders as a fact" class.
8. **Verify the 09-06 cost mitigations** (Vercel Standard build machine #61) at the next invoice; **re-measure the accuracy gate** after any ask-feed work.

---

## 8. Notes from verification

- **Shell GREEN this run.** Commit counts, line counts, path checks, and the TODO scan are all first-hand (`git log`, `ripgrep`, `wc -l`, `ls`). ⚠ **cloud git PUSH is dead** (`git push --dry-run origin main` → "could not read Username") — now root-caused as an immutable Routine binding (#55). Trevor's box + Claude Code push fine and did essentially all of this week's shipping.
- **Commits measured:** `git log --since=2026-08-31` = **~724** (41/78/176/144/120/112/53/0 across Aug 31–Sep 7). HEAD `7f4146e17` (2026-09-06 19:40 PT). The 09-07 pass shipped 0 (NO-PUSH).
- **TODO scan: 0 actionable markers in live app code** (§5) — measured via `ripgrep` over the source tree; `workers/**/node_modules` vendored markers excluded; whole-repo `grep -r` over the SQL corpus times out (documented).
- **Deletions verified by absence:** `lib/cart`, `lib/trade-escrow`, `app/dashboard/trade-hub`, `app/dashboard/gift` — all absent. **`lib/blazers-trivia.ts` verified ABSENT** (slot #12 correctly CLOSED). `docs/FREEZE.md` absent → no active freeze.
- **Launch flags verified:** `lib/launch-flags.ts` `CANDY_MLB_PUBLIC = true`, `PANINI_PUBLIC = true`; `lib/collections.ts` carries `candy_mlb` with `published: true`.
- **Counts measured this run:** CI = **18** jobs (`.github/workflows/ci.yml`); DB test files = **188** (`supabase/tests/*.sql`); Vercel crons = **35** (`vercel.json`); worker dirs = **17**; edge functions = **40**; `app/insights/*` dirs = **30**; `app/**/page.tsx` = **120**; `app/api/**/route.ts` = **455**; monolith client files 2,836 / 1,875 / 1,849 / 1,416 / 1,199.
- **Cited paths spot-checked — all resolve:** `docs/strategy/roadmap-2026-08-03.md`, `docs/strategy/go-live-2026-09.md`, `docs/reference/{known-issues,schema-truth,roadmap-status,autonomous-tasks}.md`, `docs/audits/{deep-audit-register,deep-audit-2026-08-27,audit-2026-09-06-candy-and-panini-go-live-readiness,refactor-plan-monolith-pages-2026-05}.md`, `docs/fmv-dust-filter-decision-2026-08-02.md`, `scripts/{check-brand-tokens.mjs,lib/strip-comments.mjs,qa/mobile-sweep.mjs,qa/README.md,recover-fileless-migrations.mjs}`, `lib/{launch-flags,collections,verify-wallet-gql,market-closed}.ts`, `components/telemetry/ClientErrorBeacon.tsx`. **Absent (correctly):** `lib/blazers-trivia.ts`, `lib/cart`, `lib/trade-escrow`, `app/dashboard/{trade-hub,gift}`, `docs/FREEZE.md`.
- **DB-side facts** (DB size **18,191 MB**, editions by collection, security 0/0/0/0, 0 trust breaches, 0 stalled pipelines, `public_5xx_24h` 19) come from **`docs/overnight/metrics-latest.json` (2026-09-07T08:05Z — same day, real-time from DB)**. **Accuracy** comes from **`docs/reference/roadmap-status.md` headline block re-read 2026-09-01**; **demand** (24 accounts / WAU 1 / MAU 5 / 109 saved wallets) from **`docs/strategy/go-live-2026-09.md` §1, 2026-09-06**. The nightly metrics run did not re-capture traction, so demand is 1 day old and accuracy ~6 days old — both dated samples.
- **Known-issues STATUS INDEX:** its own generated line reads **64 numbered items — 33 open · 6 partial · 25 closed**, running `#0–#65` (the index table includes #65; the "64" is the row count, since a number is skipped, not a miscount). Status is derived from each item's own first sentence.
- **Autonomous-task caveat:** the daytime monitor + night pass run against this repo, and Claude Code / device-VM Cowork pushed heavily from Trevor's box this week (~724 commits), so the working tree may differ from this snapshot by the time it is read. `docs/overnight/ledger.md` + `docs/reference/known-issues.md` are the authoritative records.
- This report did **not** edit `CLAUDE.md` or any source file and did **not** touch git — it only created this file.

---

## 9. Known-issues reconciliation (verified 2026-09-07)

The register's own generated STATUS INDEX reports **64 numbered items — 33 open · 6 partial · 25 closed**, derived from each item's own first sentence, running `#0–#65`. Spot-checked against the repo below; "Verified status" is what the code/docs show. ⛔ `closed` means the item *says* it is closed — read its own date stamp.

| # | Issue | Index status | Verified status | Evidence |
|---|---|---|---|---|
| 0 | Wallet verification | ✅ closed | Resolved-by-removal (08-08) | this run |
| 1 / 3 / 3b | Cart / Trade Hub / Gifting | ✅ closed | Removed from the tree — dirs absent | this run |
| 8 | sports-proxy 403 | 🟡 open | **REGRESSED / measured-dead** — suppressed to 2026-10-14 | known-issues #8 |
| 10 | `/dashboard` token migration | 🟡 open | Open — logic in `DashboardClient.tsx` (2,836 lines) | measured this run |
| 14 | Monolith page refactor | 🟡 open | Open — Phase 2 remains; Client files grew | measured this run |
| 22 | 🚨 Credential purge DEFEATED | 🟡 open | **Open — SECURITY** — pre-purge blob still fetchable | known-issues #22 |
| 34 | Sentry org quota exhausted | 🟡 open | **Open (operator) — MITIGATED 09-06** by the client-error beacon (M7 met) | known-issues #34 |
| 40–43 | pg_cron-waste cluster | 🟡🔴 open | Open — carried from run 4 | known-issues #40–#43 |
| 47 | `candy-editions-ingest` ~45% killed | ✅ closed | **Resolved 09-01** — falsifier answered, kills stopped | known-issues #47 |
| 48 | experiment falsifier unanswerable | 🟡 open | Open — proposed fallback lever does not exist | known-issues #48 |
| 49 | leaderboard leg | 🟠 partial | Partial | known-issues #49 |
| 50 | pack-reality "Honest +EV ranker" draining | 🟡 open | Open — both catching arms read greener | known-issues #50 |
| 51 | arm asserting an unobservable cause | 🟠 partial | Partial | known-issues #51 |
| 52 | param-blind SQL plans on PG 17 | 🟠 partial | Partial — two reads fixed; class sweep part-done | known-issues #52 |
| 53 | edge-fn eszip census | ✅ closed | Resolved 08-30 — real drift 25 | known-issues #53 |
| 54 | `match-topshot-players` daily no-op | 🟡 open | Open — needs a product decision (downstream of #8) | known-issues #54 |
| **55** | 2-hourly Routine cloud-only, cannot push | 🟡 open | **Open (operator) — binding IMMUTABLE**; recreate on-device with `requires_local_device` | known-issues #55 |
| **56** | wmc index bloat regrows ~64 MB/day; no reindex job | 🟡 open | **Open** — `wmc-reindex-verify` permanently red; a REINDEX buys ~1 week | known-issues #56 |
| **57** | PostgREST-cap unbounded-read sweep | ✅ closed | **Resolved 09-02** — all 19 triaged (4 fixed, 15 refuted) | known-issues #57 |
| **58** | `OPENSEA_API_KEY` unset → 2 Panini 502s | 🟡 open | Open (operator) — **MOOT under #64 WC-Prizm decision** | known-issues #58 |
| **59** | wallet verification dead | ✅ closed | **Resolved 09-06** — gate dropped; Atlas seller-matched check added | known-issues #59 |
| **60** | can't revoke anon from net/cron schemas | 🟡 open | Open (operator) — needs Supabase support; exposure theoretical (M1) | known-issues #60 |
| **61** | Vercel bill 75% build compute | 🟡 open | Open — downgraded to Standard 09-06; re-measure at invoice | known-issues #61 |
| **62** | true-mobile QA instrument | 🟢 open (instrument) | **Landed** — `mobile-sweep.mjs` (390 px real Chromium) | known-issues #62 |
| **63** | Candy MLB live (thin) | 🟢 open (shipped) | **Shipped 09-06** — overview only, `is_active=true` | known-issues #63 |
| **64** | Panini = WC Prizm plane | 🟡 open (decided) | **Decided 09-06** — bridge not started | known-issues #64 |
| **65** | Top Shot feed restored via Atlas | 🟡 open (shipped) | **Shipped 09-06** — Sniper serial-grain again | known-issues #65 |

(Slots #4/#5/#7/#9/#11/#12/#13/#15–#21/#23/#25–#39/#44/#45/#46 carry their prior verified status — see `PROJECT_HEALTH_2026-08-31.md` §9; not re-quoted here except where they moved.)

**Tally (per the register's own STATUS INDEX):** **64 numbered items — 33 open · 6 partial · 25 closed**, running `#0–#65`. Plus the new **go-live plan (M1–M11 / B1–B5)**, the **35.1% accuracy gate** (Top Shot sliding to 37.3%), **Candy live + Panini decided**, **18-job CI**, **188 DB-invariant test files**, and the **30 public `/insights` surfaces**.

**Bottom line for `CLAUDE.md`:** the numbers barely moved — accuracy is drifting (35.1% estate-wide, Top Shot *down* to 37.3% as ask feeds stay paused) and WAU slipped to 1 — but the week's substance was **decisions, not metrics**: Trevor delegated the four standing needs-Trevor items and all four were made and shipped on 09-06 (verification gate dropped `#59`, client-error beacon `#34`, Candy live `#63`, Panini decided `#64`), a **go-live plan with eleven measurable bars** was written, and the **dead Top Shot feed was restored from Dapper's Atlas backend** (`#65`), with a 200-Moment audit exposing that its ask/badge/supply had been frozen ~a week. The costs to watch are new: the **DB grew 35% in a week** (Atlas firehose + wmc bloat `#56`, no reindex job) and **Vercel was 75% build compute** (`#61`, mitigated, unverified). The register grew `#0–#54` → `#0–#65`. And the top-line framing is unchanged and slightly worse: with the site public and self-serve ~7.5 weeks, **WAU is 1 against a 50+ gate** — **demand is still the one number that decides everything.**
