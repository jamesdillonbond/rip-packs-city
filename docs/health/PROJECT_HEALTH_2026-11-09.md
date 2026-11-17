# Rip Packs City — Project Health Report

**Date:** 2026-11-09
**Compiled by:** Claude (Cowork) — automated weekly run
**Sources:** `CLAUDE.md` + `docs/reference/known-issues.md` (generated STATUS INDEX, now reading **240 numbered items — 4 open · 7 partial · 229 closed**, newest slot **#242**), the canonical forward plan `docs/strategy/roadmap-2026-10-17.md`, `docs/reference/roadmap-status.md` (headline-metric block re-read 2026-11-07, the price-accuracy block, the demand re-read of PT week 10-29..11-04, and the "Decisions taken" / "Open items" / "Needs Trevor" ledgers), `docs/reference/architecture-notes.md`, `docs/overnight/ledger.md` (1,012 `### ` headings on the mount), `docs/overnight/metrics-latest.json` (the 2026-11-08 ~1:08 AM PT overnight pass) plus the 2026-11-09 ~1:05 AM PT overnight handoff for the most recent live read, the 2026-11-01 monthly strategy & traction review, and first-hand file-tool + shell scans over the connected repo (`git`, `grep`, `wc`, `ls`) at ~03:15 AM PT.
**Scope:** A single consolidated, themed view of open work — the numbered known-issue slots (`#0–#242`), the go-live framing, the prioritized actions, the overnight operational queue, and the in-code marker inventory — with suggested severity, effort, and a recommended sequence.
**Prior report:** `PROJECT_HEALTH_2026-11-02.md` (7 days ago). This regeneration mirrors its structure. `_2026-10-26.md` … `_2026-05-22.md` (twenty-six earlier reports) also live in `docs/health/`.

> **Biggest change since 2026-11-02 — the week's center of gravity was PRICING ACCURACY and a full security audit, with a big new Candy census and a trophy/challenge arc alongside.** The week shipped **1,050 commits since 11-02** (up from last week's 532, a very heavy week), again almost all interactive Cowork / Claude Code — the autonomous pass stayed green-and-idle every night. The dominant workstreams were (1) **pricing accuracy as "the anchor of everything"** (Trevor, 11-04): a cluster of 11-04 evening FMV changes (ask-only capped at the last sale, every Top Shot price floored at the best open edition offer ≤ 3×, the thin-sale haircut stops at that bid, All Day LOW haircut 0.55 → 0.75, `basis_capped` survives `_bidfloor`) **and a brand-new accuracy instrument `fmv_accuracy_weekly` (#234)** that measures each sale against the price published ≥ 1 day before it — the first time confidence LABELS are being checked against realised ACCURACY; (2) **a full CISO security audit (#229, 11-04)** — a live vuln/pentest pass that shipped the trade-room relay guard, wallet-verification binding, input validation, `.npmrc` hardening, 24+13 constant-time secret compares (#230), Dependabot (#231), a WAF deny rule, 9 sensitive env secrets, MFA across every provider, and `main`-branch protection; (3) **a large Candy census expansion** — non-registry Candy collections grew editions **125 → 22,127**, which (by design, fail-safe) lit the `edition_integrity_flags` gate and is now a queued decision; and (4) **a trophy/challenge arc** — Dame Time challenge cases, a challenge-aware main-case picker, "Fill my case," plus the Series-1 thumbnail (#236) and Dame Time share-link (#239) fixes. The register grew **17 slots (#226–#242)** and **closed +15 (214 → 229)**; open+partial moved **9 → 11**. Both founder-only residues from last week — **#223** (the cross-collection quarantine paste) and **#225** (UFC video) — are CLOSED, along with **#213**, **#221** and the 11-04 audit cluster (#230/#231/#232/#233). The current open set is pricing/measurement (#234), an external-crawler mitigation (#235), two pg_net/pack-metadata plumbing items (#241/#242), and the two partials from the accuracy + security arcs (#228, #229).

> **Overnight reality — GREEN and idle by design, again, every night this week.** The 2026-11-09 ~1:05 AM PT pass (Cowork cloud, push-capable via the laptop-VM route, no `FREEZE`) shipped only **two small Candy-census hygiene migrations** (`20261109044329` row-budget on `rpc-candy-wmc-label-fill`, `20261109044509` scoped ghost-purge) and otherwise logged a quiet, healthy night: every other actionable candidate was in **hot census files** being actively tuned by other sessions (off-limits), a **query cut that needs the handoff path** (#242), or a **trust-gate decision** premature while the census is still expanding. The 11-08 pass shipped 0 / reverted 0. The week's shipping was all interactive Cowork / Claude Code sessions.

> **Traction reality — a small activation nudge, still QA-confounded, far from the gate.** The latest weekly demand read (PT week 10-29..11-04, `scripts/demand-read.sql`, read 11-07) shows **69 human browsers / 149 visits** (63 / 98 the week before), **5 external signed-in users** (up from 2), **1 signup** — but ⚠ **the visit jump is mostly our own QA browsers** (direct 59 → 105, heaviest browsers on `/admin/*`, `/trades/<room>` and `/dashboard` — the trade room went live 10-31 and was tested all week), so read `direct` as an upper bound. Search did not grow (Google 25 → 20 landings). The 30-day monthly review (2026-11-01) still reads **WAU 4**, **MAU 15**, **38 accounts** (33 usernames), **5 new accounts / 30 d**, **1 email subscriber**, and the standout **outbound buy-link clicks 222 (↑~18× MoM)**. ⚠ The user gate is **100 WAU** and **outreach is off** (Trevor, 10-14). The cliff is still the authed step, not acquisition. Next weekly re-read ~**11-12** (confounded again by the 11-06 IA re-launch and heavy cloud QA — split by `metadata.automated` first).

> **Accuracy gate — read the series, not the leg; a NEW instrument now measures accuracy itself.** File-blessed weekly-mean legs (`rpc_trust_health_history`, roadmap-status 11-07 block, wk 11-02 partial 21–22 legs): **Top Shot (M1) 45.6 %** (🔴 under its 50 % bar *by decision* — FMV 1.8.2 requires a usable sale within 30 days; the +0.7 is composition as Series 2026-27 trades, not the 11-04 fixes), **All Day (M2) 26.8 %** (🔴, and now **drifting DOWN ~0.3/wk** — 27.4 → 27.1 → 26.8, reversing last week's "edging up" read; 3.2 under its bar), Pinnacle **32.7 %** (own leg, never averaged), Candy **48.1 %** (⬇ the frozen-market window is draining, as predicted ~11-10), Panini **45.7 %** (flat), Golazos **0.2 %**, UFC **0.0 %** (closed-market sentinel). ⭐ **The 11-04 price changes move PRICES, not labels, so they cannot move these shares** — their effect is read in the new `fmv_accuracy_weekly` instrument (#234), whose first post-change window is the **11-09 week, first filling Mon 11-16**. Top Shot baseline (wk 10-26, within ±25 %): ALL 68.2 · HIGH 74.3 · MEDIUM 69.1 · LOW 54.9 · ASK_ONLY 48.6; All Day baseline 62.1 %.

> **Cost / storage — ~45.6 GB, swinging on the pg_net sawtooth + legitimate Panini growth.** Live reads: DB **45,643 MB (~45.6 GB)** at the 11-08 1:08 AM pass (down from 46,281 the prior read — the documented `net._http_response` sawtooth), operating band ~42–46 GB. Durable growth is Panini: editions **40,574 (+~400 week-over-week)**, `panini_card_serials` ~9.3 GB. Compute stays **LARGE** (resized 09-20). ⚠ The ~4.2 GB June DB-size baseline doc remains **badly stale** — the real operating baseline is ~42–46 GB; resetting it so it stops reading as a ~10× regression is still an open housekeeping item. A `net._http_response` growth read is owed to Trevor ~**11-11**.

> **Platform context.** Top Shot's public REST API stays dead; the Atlas backend is the feed and answers a Cloudflare 403 on some lanes by design (self-healing). **Flowty stays RETIRED (10-30)** — `flowty-proxy` is a 410 tombstone; All Day / Golazos / Pinnacle asks come from Dapper's own storefronts. **Candy/Solana is LIVE but its market has been frozen since 2026-10-11** — `candy_sales_stale_hours` (666 h on the 11-09 pass) + `candy_ask_book_drop_pct` (86.2 %) are the honest downstream symptoms of a real dead market (#58), dispositioned, not a new defect; the OpenSea-key revisit is ~11-27. **A large non-registry Candy census** grew editions 125 → **22,127** this week (insert-only), which lit `edition_integrity_flags` (fail-safe, LOW blast radius) — a queued decision, not a live user-facing breach. NFL All Day secondary-market only. UFC Strike Flow market frozen (0 sales; honestly labelled; video stays gateway-bound by decision, #225). Panini = WC Prizm + basketball plane (`PANINI_PUBLIC = true`); the collector-walk runs on Trevor's laptop.

> This is a snapshot. `CLAUDE.md` + `docs/reference/known-issues.md` are the source of truth for project memory; `docs/overnight/ledger.md` for what shipped; `docs/strategy/roadmap-2026-10-17.md` for the plan. This doc reorganizes them for triage. **Severity and effort tags throughout are suggestions, not gospel.**

> **Report location stays clean.** All reports (this one included) live in `docs/health/`; the repo root holds none (verified this run).

---

## 1. At a glance

| Bucket | Count | Notes |
|---|---|---|
| Known-issue slots tracked | **#0–#242** | Register STATUS INDEX: **240 numbered items — 4 open · 7 partial · 229 closed**. 17 new slots (#226–#242) since last week. See §9. |
| Known issues — resolved/closed since last week | **+15 net** | Closed count rose 214 → 229. Moved off the open/partial list: #213, #221, #223, #225 (all closed) — see §6 / §9. |
| Known issues — open / partial | **11** | **4 open** (#234, #235, #241, #242) + **7 partial** (#66, #208, #209, #210, #218, #228, #229). Up from 9 last week. — §3 / §9 |
| Known issues — 🚨 live trust breach | **0 user-facing** | On the 11-09 pass: 3 known-shape **dispositioned** breaches — `edition_integrity_flags` 20,627 (Candy census fail-safe, LOW blast radius) + the Candy-closure cluster (`candy_sales_stale_hours` 666h, `candy_ask_book_drop_pct` 86.2 %). `topshot_impossible_parallel_serials` 0; `v_fmv_sanity_flags` 0. — §2.4 |
| Known issues — needs Trevor, operator | **few** | **#229** secret-rotation tiers (MFA/WAF/branch-protection all done); **#241/#242/#228** query cuts (Claude Code); the **Candy-census** `edition_integrity_flags` decision; **#58** OpenSea key (~11-27); **#66** external links (gated); `net._http_response` read (~11-11); C2 postal address; S1/S3/S6 console token rotation. — §2.6 |
| Known issues — carried shelved | **~1** | **#58** OpenSea key — the 3 candy-opensea lanes stay unscheduled; only a Trevor-set key would resume the Candy book, if ever wanted (re-verify ~11-27). |
| Known issues — removed from the tree by decision | 3 | #1 Cart, #3 Trade Hub, #3b Gifting — DELETED (read-only pivot). Verified still absent this run. |
| Go-live plan | **M1–M11 + B1–B5** | `docs/strategy/go-live-2026-09.md`. Accuracy gate: Top Shot met (series, by-design ~45–46 % leg), All Day short and slipping. Demand is the binding bar. — §2.1 |
| Commits since last report | **1,050** | `git log --since 2026-11-02` on the connected mount. Authors: Claude 842, Claude (Cowork) 93, Trevor 91, monitor/nightly bots ~20. Mount HEAD `b50e4b281` 2026-11-08 22:27 PST (Trevor); mount is level with origin. |
| Accuracy gate (headline metric) | **Per-collection, weekly-mean legs** | Top Shot **45.6 %** (by-design 1.8.2 re-grade; read as a series), All Day **26.8 %** (NOT MET, drifting DOWN), Pinnacle 32.7, Candy 48.1 (relabel, draining), Panini 45.7, Golazos 0.2, UFC 0.0 (sentinel). — §2.1/§2.3 |
| Price accuracy (the second number) | **NEW instrument `fmv_accuracy_weekly`** | Measures sales vs the price published ≥ 1 d before (#234). TS baseline wk 10-26 within ±25 %: ALL 68.2 / HIGH 74.3 / MED 69.1 / LOW 54.9 / ASK_ONLY 48.6. First read of the 11-04 fixes = **11-09 week, fills Mon 11-16**. — §2.3 |
| Demand (the critical-path number) | **thin; small nudge, QA-confounded** | 30-day (11-01): WAU 4, MAU 15, 38 accounts, buy-link clicks **222 (↑~18×)**. Weekly (10-29..11-04): 69 browsers / 149 visits (mostly our QA), **5 signed-in** (↑ from 2), 1 signup. Gate **100+ WAU**; **no outreach** (10-14). — §2.1 |
| Open overnight operational items | **standing queue** | Candy-census lock-contention on `wallet_moments_cache` (MED, Claude Code); `edition_integrity_flags` 20,627 decision; #242 `backfill-pack-rip-metadata` ~19s fixed cost; #228 cold-whale snapshot (lever-b′ shipped); #58 OpenSea (~11-27). — §2.6 |
| Net-new structural workstream | 2 live + utility layer | Candy/Solana LIVE (thin, market frozen; census expanded to 22,127 editions) + Panini (WC Prizm + basketball, collector-walk live); plus the collector-utility layer (Trade Room, trade-in finder, follows, checklists, trophy challenges) and a paused Rewards economy. — §2.8 |
| Prioritized next actions | **canonical** | `roadmap-2026-10-17.md` (accuracy-is-the-gate) + `go-live-2026-09.md`. Gate: **100+ WAU**, no outreach, no infra spend pre-revenue. See §4. |
| In-code TODO markers | **0 actionable** | Measured this run (`git ls-files` + `grep`): **6** match lines, all narrative/false-positive (incl. the `$X,XXX.XX` literal). — §5 |
| Test / DB-invariant pins | **295 `supabase/tests/*.sql` files** | +8 vs last week's 287 (measured this run, `ls`). |
| CI jobs (ci.yml) | **21** | Measured this run under `jobs:` — unchanged from last week (same 21). See §8. |
| Public `/insights` surfaces | **39** | Measured this run: 39 `app/insights/*/page.tsx` dirs (+1 vs 38). |
| Active revenue-blocking items | 0 | By decision — monetization tabled until 100+ WAU. |

**Health read:** Another very heavy, clean shipping week — 1,050 commits, almost all interactive, the autonomous pass green-and-idle every night. The two founder-only residues that topped last week's P1 list (**#223** quarantine, **#225** UFC video) both closed, and the week's new slots are overwhelmingly shipped-and-closed in the same window (#226/#227/#230/#231/#232/#233/#236/#237/#238/#239/#240). The register's open work grew modestly (9 → 11), and the shape is healthy: it is **pricing accuracy** (the #234 instrument + the 11-04 cap cluster), one **external-crawler mitigation** (#235, WAF rule now in Challenge mode), two **plumbing** items (#241 pg_net attribution, #242 a pack-metadata query cut), and the tails of the **accuracy** (#228) and **security** (#229) arcs. The concentrated risk is unchanged in shape: **(1) demand** — external WAU is a handful against a 100-WAU gate with outreach off, and the latest weekly nudge is mostly our own QA traffic; **(2) All Day accuracy** — M2 is not just short of its bar, it is now slipping (26.8 %, -0.3/wk); and **(3)** a Candy-census housekeeping decision (`edition_integrity_flags` 20,627, fail-safe). Live user-facing trust metrics are clean (0 impossible serials, 0 FMV sanity flags); the three standing breaches are known-shape and dispositioned (Candy closure + the fail-safe census gate).

### Themes

| Theme | Items |
|---|---|
| **Launch / activation (the whole critical path)** | Public + self-serve. Demand nudged (5 signed-in, buy-link clicks ↑18× MoM) but QA-confounded and flat on search. Gate **100+ WAU**, **outreach off** (10-14). Still an *activation* problem. (§2.1) |
| **Pricing accuracy — "the anchor of everything" (the week's biggest arc)** | #234 confidence labels are a 30-day SALES COUNT, not measured accuracy; new `fmv_accuracy_weekly` instrument; the 11-04 cap cluster (ask-only→last sale, floor at best open offer ≤3×, haircut-stops-at-bid, All Day LOW 0.75, basis_capped survives _bidfloor). First read 11-16. (§2.3) |
| **CISO security audit + remediation (#229)** | Full vuln/pentest 11-04: trade-room relay guard, wallet-verification binding, input validation, `.npmrc` hardening, 37 constant-time secret compares (#230), Dependabot (#231), WAF deny rule, 9 sensitive env secrets, MFA every provider, `main` branch protection. Rotation TIERS still Trevor's. (§2.4) |
| **Candy census expansion (new structural)** | Non-registry Candy editions 125 → 22,127 (insert-only); lit `edition_integrity_flags` (fail-safe); census lock-contends with `rpc-candy-wmc-label-fill` on `wallet_moments_cache`. Market still frozen. (§2.6/§2.8) |
| **External crawler sweep (#235)** | An unnamed, multi-region (≥10 edge PoPs) fetcher sweeps ~hundreds of entity pages near 5 PM PT every few days, degrading the whole site ~30 s for real users. WAF "Entity page sweep" rule now **Challenge** (keyed on JA4). (§2.5) |
| **Trophy / challenge arc** | Dame Time challenge cases + challenge-aware main-case picker + "Fill my case"; Series-1 thumbnail fix (#236), Dame Time share-link fix (#239), trophy-share-CTA telemetry. (§2.3) |
| **Identity / search parity** | wmc player names now follow the person (#221 closed, daily heal cron); team nicknames in search + resolver (#238); wallet-indexed three-states (#237); display-name / signup-trigger work. (§2.3) |
| **Live trust — user-facing CLEAR; three dispositioned known-shape breaches** | `topshot_impossible_parallel_serials` 0; `v_fmv_sanity_flags` 0; Candy-closure cluster + census `edition_integrity_flags` are fail-safe/expected (§2.4) |
| **Pricing-tier caps (carried partials)** | #208 ASK_ONLY (All Day + Golazos) EXIT MET on 11-05; #209 STALE (TS + All Day); #210 thin-sale haircut depth floor — each a partial with a weekly tail (§2.3) |
| **Cold-whale snapshot (#228) + plumbing (#241/#242)** | #228 `/api/collection-snapshot` timeouts — index swap + route-wait + CDN stale window shipped; #241 pg_net 4xx attribution blind to request_id-NULLing lanes; #242 pack-metadata ~19 s fixed cost (§2.3/§2.6) |
| Security | scans clean; user-facing trust clear; CISO remediation mostly shipped; #60 (can't revoke anon from net/cron schemas) carried, needs Supabase support (§2.4) |
| Product simplification — READ-ONLY pivot | Cart / Trade Hub / Gifting **DELETED** — verified still absent. (The Trade Room is no-custody, signed, user-to-user.) (§2.9) |
| SEO | #66 — code items done; 10-28 Search Console re-read done (49.4K indexed); the edition-title CTR re-read MEASURED 11-05 (not reverting); external links remain Trevor's, gated (§2.3) |
| Tech debt / refactor | Monoliths re-measured: DashboardClient **2,966** / SniperClient **2,244** / CollectionAnalyticsClient **2,037** / CollectionTabClient **1,847** / MarketClient **1,383** (§3) |
| DB-size baseline | The June ~4.2 GB baseline doc is still stale; operating ~42–46 GB on the pg_net sawtooth + Panini growth. Reset it (§2.6) |
| Deferred hardening (intentional) | Public INSERT-policy tables; `owner_key`→`user_id`; Golazos `highest_offer` gap (settled); `INGEST_SECRET_TOKEN` rotation owed; `buildTopshotPoolPayload` fabricated-divisor (latent, no live caller) |

---

## 2. Critical path — start here

Go-live is **operationally done** (public + self-serve). The forward plan is **`docs/strategy/roadmap-2026-10-17.md`** (canonical; accuracy is the GATE, headline metric is the HIGH/MEDIUM confidence share read as a series) plus **`docs/strategy/go-live-2026-09.md`** (what "through the gate" means in numbers). The binding user bar is **100+ WAU** (raised from 50 on 09-25), and **outreach is off** (Trevor, 10-14).

### 2.1 Launch + activation — accuracy near its bars (All Day slipping), demand nudged but QA-confounded — `Severity: High · Effort: Medium (built + measured, no traffic by directive)`

Read-only tabs are anonymous for the 5 published Flow collections (+Candy overview, +Panini); cost-basis/P&L, saved wallets, watchlist, `/dashboard/*`, the Trade Room, and every mutation stay behind sign-in.

- **Traction, 30-day monthly review (2026-11-01):** WAU **4** (internal-excluded), MAU **15**, **38 accounts** (33 usernames), **5 new accounts / 30 d**, **1 email subscriber**, and the standout — **outbound buy-link clicks 222 / 30 d, up ~18× MoM**. (A week old; the next monthly is due ~12-01.)
- **Weekly demand read (PT week 10-29..11-04, `scripts/demand-read.sql`, read 11-07):** 69 human browsers / 149 visits, **5 external signed-in users** (up from 2), **1 signup**, 37 wallet-pastes (6 browsers), 13 share views, one share-CTA sign-in click (0 the week before), 2 magic-link requests. ⚠ **The +46 visits are mostly our own QA browsers** (direct 59 → 105; three browsers on `/admin/*` = 24 visits, the heaviest browser lives on `/trades/<room>` + `/dashboard`). Excluding only the 3 `/admin` browsers: 125 visits / 66 browsers. Read `direct` as an upper bound. **Search did not grow** (Google 25 → 20 landings, 75 % one-page). Next re-read ~**11-12** (confounded by the 11-06 IA re-launch + cloud QA — split by `metadata.automated` first).
- **Accuracy (weekly-mean legs, roadmap-status 11-07 block, wk 11-02 partial):** **M1 Top Shot 45.6 %** (under 50 % *by decision* — the 1.8.2 MEDIUM re-grade; +0.7 is composition as Series 2026-27 trades), **M2 All Day 26.8 % (≥ 30 % — NOT MET, and drifting DOWN ~0.3/wk)**, Pinnacle 32.7, Candy 48.1 (relabel, draining), Panini 45.7, Golazos 0.2, UFC 0.0 (sentinel). ⚠ Read the series, not the leg.

The critical-path action is unchanged by directive: with outreach off (10-14) and the gate at 100 WAU, keep accuracy beating the incumbents (the gate) and close the activation drop-off. The clearest lever remains **converting the anonymous traffic already arriving** — a no-login, high-intent anon → wallet-paste → "here's your squeeze / EV / what to chase" path tuned on the two growing actions (wallet_paste, outbound clicks). Demand is still the single most important line in the report, and it is an *activation* problem more than an acquisition one. **All Day's accuracy slip is the new watch:** M2 is not merely short of its bar, it has fallen three weeks running, and the lever (LOW → MEDIUM) needs real reclassification, not a label change.

### 2.2 Public intelligence surfaces — 39 public — `Severity: n/a (shipped) · context`

All 39 built surface dirs in `app/insights/` are public (measured this run: 39 `page.tsx`, +1 vs last week). The per-collection squeeze split (e.g. `/insights/allday-squeeze`, `/insights/allday-set-squeeze`) persists so a crawler/unfurler sees the right collection (the 10-27 architecture note). Carried honesty risks `#50` (`/insights/pack-reality` ranker) and `#33`-class (ISR bakes a failed read into the `revalidate` window) remain as standing design considerations.

### 2.3 Data-intelligence — the pricing-accuracy arc + the FMV-cap tail — `Severity: Medium (correctness) · Effort: mixed`

**FMV HIGH/MEDIUM counts (11-08 overnight pass):** Panini 17,998, NBA Top Shot 6,851, NFL All Day 1,755, Pinnacle 939, Candy 31, Golazos 1, UFC 0. (Candy MED↔LOW churns on a frozen 125-edition market; UFC 0 is the closed-market honest label.)

**Shipped / landed since last week:**

- **The 11-04 pricing-accuracy cluster.** Ask-only capped at the edition's last sale (`20261105024000`); every Top Shot price floored at the best open edition offer ≤ 3× (`20261105033000`); the thin-sale haircut stops at that bid (`20261105044500`); All Day LOW unknown-depth haircut 0.55 → 0.75 (`20261105050000`); `basis_capped` survives `_bidfloor` (`20261105063000`). **Plus a new accuracy instrument (#234): `fmv_accuracy_weekly`** — per collection × PT week × confidence × last-sale age × depth × price band, with n / within ±25 % / median ratio / WAPE; pg_cron `rpc-fmv-accuracy-weekly` (Top Shot jobid 828 Mon 3:37 AM PT, All Day jobid 829 added 11-05). It is the first time confidence LABELS are being checked against realised ACCURACY. First post-change read = the **11-09 week, fills Mon 11-16**.
- **Trophy / challenge arc.** Dame Time challenge cases filled at close (`fill_partial_challenge_cases`), a challenge-aware main-case picker, "Fill my case" (`POST /api/profile/trophy-cases/fill`, propose → confirm → pin, Top Shot only), and trophy-share-CTA telemetry. Our own QA page-views now count into `automated_pageview_hourly` instead of rows.
- **Identity / search parity.** #221 closed: `wallet_moments_cache.player_name` now follows the person via `heal_wmc_player_names_from_catalog` (pg_cron 834, daily). #238: team nicknames resolve in search (`team_name_aliases`). #237: `walletIndexState()` gives the three honest "ever walked?" states.
- **SEO (#66).** The edition-title CTR re-read was MEASURED 11-05 (Search Console via Trevor's Chrome): not reverting — the price-free titles reached 3.0 % CTR (above the 1.2 % pre-change). A false "LIVE DEALS BELOW ADJUSTED FMV" subtitle on `/ufc/sniper`'s server-rendered body (market closed since 5/13) was found and fixed (`lib/sniper/header-copy.ts`).

**New / open:**

- **`#234` — FMV confidence labels are a 30-day SALES COUNT, not measured accuracy (OPEN, NEW 11-04).** HIGH ≥ 7 / MEDIUM ≥ 5 sales in 30 d says nothing about how close the price lands, and the two disagree both ways (MEDIUM 31–90 d old read ~53 % within ±25 % — over-claims; some ASK_ONLY read 62–69 % — MEDIUM-grade, labelled lowest). The instrument now exists; **EXIT:** once the 11-09 week fills (Mon 11-16), relabel by measured segment accuracy — the label's promise must match its segment's within ±25 %; labels stay INTERNAL (rule 3). Handoffs: `docs/handoff-2026-11-04-*`.
- **`#228` — cold-whale `/api/collection-snapshot` timeouts (PARTIAL).** The largest wallets timed out honestly (`RPC_READ_TIMEOUT`) when cache-cold. Shipped: a covering index + STALE-only `conf` read (lever a), a 20 s route wait (lever b′), the index-name swap (11-04), and a 6 h CDN stale window (lever b, 11-08). **Open:** still fires ~4×/24h; a stored snapshot is the next lever if the CDN window does not hold. Routed to Claude Code (5 nights).
- **`#241` — pg_net 4xx attribution is blind to lanes that NULL their `request_id` on collect (OPEN, NEW 11-08).** `check_edge_fn_http_failures` files their 403/429s as "endpoint unknown." Not harmful today (both measured lanes re-queue without burning an attempt and are caught up). **Fix shape:** a small `pg_net_request_lanes` table + one LEFT JOIN arm.
- **`#242` — `backfill_pack_rip_metadata` has ~19 s of FIXED cost per call under load (OPEN, NEW 11-08).** Two eligibility legs build their whole eligible set before a small LIMIT, so cost is independent of `p_limit`; the 50 s budget fails during IO spells. A spell-free hour still succeeds. **Next:** run the legs on a slower cadence or from a precomputed eligibility table (three-file pinned change, Claude Code).
- **`#208 / #209 / #210` — pricing-cap partials (carried, with weekly reads).** #208 (All Day + Golazos ASK_ONLY cap): **EXIT MET on the 11-05 weekly read** (All Day ASK_ONLY ratio 1.008, within ±25 % 44.2, bar ≥ 30; falsifier not met) — only part (a), the no-180 d-history class, stays open (dispersion, no multiplier is a lever; left to #234's relabel). #209 (TS + All Day STALE cap): basis-line half SHIPPED 10-25; weekly reads still too thin to judge. #210 (thin-sale haircut depth floor): Top Shot exit met; All Day 0-sale cut + the depth term itself stay open (no listing-history input exists to backtest a real depth term).
- **`#66` — SEO (PARTIAL, needs Trevor):** every code item done; the 10-28 Search Console re-read done (49.4K indexed, up from 31.8K); the edition-title CTR re-read measured 11-05 (not reverting). What remains is external links, held by the accuracy gate (Trevor).

### 2.4 Security, confidentiality + test infrastructure — `Severity: Medium (clean scans; 0 user-facing breaches) · Effort: mostly landed`

- **The 2026-11-04 CISO security audit (#229, PARTIAL — most shipped).** A full vuln/pentest pass (`docs/audits/2026-11-04-ciso-security-audit.md`). Shipped the same day: the trade-room relay guard (a relayed signable is checked against the room — cadence, authorizers, payer, every Moment per side), wallet-verification bound to the RPC account, handle/accent/avatar validation on `/api/profile/bio`, the OG-avatar fetch gated on the CSP host list, durable anon caps on `/api/wallet-search` + new `chat_sessions`, 37 constant-time secret compares (#230 closed), `.npmrc` `ignore-scripts=true` + `min-release-age=7`, 9 Vercel env secrets flipped to `sensitive`, a WAF deny rule for `/.env` `/.git/HEAD` `/wp-admin/` etc., Dependabot enabled (#231 closed, HIGH alerts → 0), MFA verified on **every provider** the runbook names (Supabase, Vercel, GitHub, cron-job.org — a TOTP added 11-06), and `main`-branch protection (ruleset `protect-main`, restrict deletions + block force-pushes). **Still Trevor's:** the secret-rotation TIERS in `docs/operations/secret-rotation-plan-2026-11.md` (2 of 9 vars were DEAD and deleted; the service-role key can't retire without the legacy JWT keys). Re-audit cadence quarterly, next 2027-02-04.
- **Security scans clean** (invariants, anon-write holes, rls-off-base-tables, secdef-anon all `[]`, per `rpc_ops_snapshot.security`, both recent passes). A transient `rls_off_base_table:_scratch_golazos_official_…` smoke failure on the 11-09 pass self-resolved (scratch table dropped; live invariant check clean).
- **Live trust — user-facing clear, three dispositioned known-shape breaches.** `topshot_impossible_parallel_serials` 0; `v_fmv_sanity_flags` **0**. The 11-09 pass read 3 breaches, all known-shape: `edition_integrity_flags` **20,627** (the Candy census 125 → 22,127, tier/circ/thumbnail nulls — fail-safe, LOW blast radius, a queued decision), and the Candy-closure cluster (`candy_sales_stale_hours` 666 h + `candy_ask_book_drop_pct` 86.2 %, dispositioned 11-08). `trust_precompute_max_age_hours` 5.27 ok, so the breaches are real reads, not staleness.
- **`#60` (carried):** Postgres cannot revoke `anon`/`authenticated` from the `net`/`cron` schemas; real fix needs Supabase support.
- **DB-invariant SQL layer: 295 `supabase/tests/*.sql` files** (+8, measured this run). CI is **21 jobs** in `ci.yml` (unchanged). **Never lower thresholds to green a build.**

### 2.5 Automation / asset hygiene — `Severity: Low–Medium · Effort: ongoing`

⚠ **`#235` — an unnamed external crawler degrades the whole site (NEW 11-06).** A globally distributed fetcher sweeps a few hundred `/<collection>/edition|set|series|player|team/*` pages in under a minute, about every few days near 5 PM PT, arriving through ≥ 10 edge regions at once (so a per-IP limit evades it), and each sweep pushes the site into its degraded states for ~30 s for real users. Mitigation is IN: a Vercel WAF rule `Entity page sweep` (keyed on **JA4 digest**, 300 req / 60 s), **switched Log → CHALLENGE 11-08 10:10 PM PT** by Trevor. ⚠ Challenge will also challenge our own cloud QA sweeps that pass 300/min on one fingerprint — keep `RPC_QA_CONC` low and read a challenge page in a sweep as this rule, not an outage. **Exit:** a week with no minute > 400 invocations, or a decision to accept the honest degradation. A read-only review is scheduled 2026-11-13 9 AM PT. ⚠ The firewall-config MCP still 404s "Seawall Config not found" — read the rule in the dashboard.

⚠ **`#34` — Sentry dark; no-spend DECIDED** — the `window.onerror`/rejection beacon → `usage_events.client_error` is the detector; recent passes read 1–3 benign CSP `unsafe-eval` events (injected extension, not our code). ⭐ **`#114` dashboards** stay ported to claude.ai artifacts (desktop-session work, last roster read 09-14). The true-mobile QA instrument (`scripts/qa/mobile-sweep.mjs`, real Chromium at 390/320 px) remains the only real mobile instrument.

### 2.6 Overnight operational queue — `Severity: Low–High (mixed) · Effort: mixed`

Health scans GREEN on the 11-09 pass (0 stalled pipelines). Open items for Trevor / operator / Claude Code:

| Item | Issue | Severity | Notes |
|---|---|---|---|
| **Candy-census lock-contention** | `candy-collections-census` intermittently lock-contends with `rpc-candy-wmc-label-fill` on `wallet_moments_cache` (pages advance 66→227, not wedged). | **Med (Claude Code)** | Cut the per-set hydrate budget (like the 11-08 label-fill cut) OR deconflict the two writers (lock_timeout / schedule offset). Census + ~30 candy files are hot. |
| **`edition_integrity_flags` = 20,627** | `candy_mlb` tier/circ/thumbnail nulls from the 11-08 insert-only census (125 → 22,127 editions). Fail-safe, LOW blast radius. | **Med (decision)** | Settle whether non-registry Candy collections have a tier/circ/thumbnail source; if structurally absent, exclude those columns from `v_edition_integrity_flags` (view edit, no data change). **Do NOT raise the 250 threshold.** Best once the census settles. |
| **#242 — `backfill-pack-rip-metadata`** | ~19 s fixed cost/call; fails the 50 s budget during IO spells. | Med (Claude Code) | Three-file pinned query cut: slower cadence or a precomputed eligibility table. |
| **#228 — cold-whale snapshot** | `/api/collection-snapshot` still ~4×/24h `RPC_READ_TIMEOUT`. | P3 (Claude Code) | Lever-b′ (20 s wait) + CDN 6 h stale window shipped; a stored snapshot is the next lever. |
| **#229 — secret-rotation tiers** | MFA/WAF/branch-protection/Dependabot all done; the rotation TIERS in the plan are Trevor's. | Med (operator) | `docs/operations/secret-rotation-plan-2026-11.md`. Do before marketing. |
| **#58 OpenSea key** | 3 candy-opensea lanes unscheduled; only a Trevor-set key resumes the Candy book. | Low (optional) | Candy re-verify ~11-27. |
| **S1 / S3 / S6 + C2** | console token rotation (cron-job.org, GHA, Vercel) + CAN-SPAM postal address (`RPC_SENDER_POSTAL_ADDRESS`). | Med (operator) | Do before marketing; digests stay flag-off until C2 exists. |
| **`net._http_response` read** | weekly growth read (the pg_net sawtooth). | P4 (Trevor) | Due ~11-11. |
| **DB-size baseline doc** | The June ~4.2 GB baseline reads as a ~10× regression against ~42–46 GB operating. | Low (housekeeping) | Reset it; keep the sawtooth + Panini growth on watch. |

### 2.7 Pack EV / pack-viz — `Severity: Low–Medium (correctness, mostly clean) · Effort: mostly landed`

Pack-EV surfaces label rows for packs nobody can buy and disclose AllDay/Golazos EV as an original-supply model; Candy leads with Typical-Pull median; the packs "Chase left" view shows sealed high-tier density vs launch. The #218 pack-index work matured further this week (the chain now names packs minted after the Studio freeze via the forward tail probe + `flow_height_estimate` anchored on `pack_purchases`). Pack-EV freshness holds (the designed per-page Atlas 403 re-ask drives the `topshot-pack-supply-atlas` fail count, not a real outage).

### 2.8 Chain foundation — Candy LIVE (frozen market, census expanded), Panini walked + parity-built, utility layer, Rewards paused — `Severity: Low (shipped) · Effort: landed`

- **Candy / Solana — LIVE, THIN, market FROZEN since 10-11:** `CANDY_MLB_PUBLIC = true` (verified this run). The non-registry census grew editions **125 → 22,127** this week (insert-only), which lit `edition_integrity_flags` (fail-safe) and is now a queued decision; the census lock-contends with the every-4-min `rpc-candy-wmc-label-fill` writer. `candy_sales_stale_hours` / `candy_ask_book_drop_pct` are the honest downstream symptoms (re-verify clock ~11-27).
- **Panini — the WC Prizm + basketball plane** (`PANINI_PUBLIC = true`, verified this run). Collector-walk keeps adding editions (**40,574**, +~400 wk; `panini_card_serials` ~9.3 GB, the main durable DB-size driver). The old-catalogue backlog DRAINED this week (2,097 > 7 d, was 18,431 on 11-04; 6 runs/day stays). #240 closed (a Panini HIGH without a recent sale is not less accurate — the defect was concierge wording).
- **Collector-utility layer:** the no-custody user-to-user Trade Room (signing live since 10-31, `RPC_TRADE_ROOM_EXECUTE`), the trade-in finder, follow-a-player, player checklists, and now trophy challenges — a utility layer around Top Shot's transactions, not a competitor to them.
- **Rewards economy — exists but PAUSED (dial-in).** No new participation this week.
- **Chain-abstraction Phases A–F complete.**

### 2.9 Read-only product pivot — carried, verified still in effect — `Severity: n/a (landed) · Effort: (done)`

Cart, Trade Hub, and Gifting remain **deleted from the tree** — verified this run by absence: `lib/cart`, `lib/trade-escrow`, `app/dashboard/trade-hub`, `app/dashboard/gift`, `lib/blazers-trivia.ts`, `docs/FREEZE.md` all absent. The product is read-only except for admin-signed giveaway delivery and the **no-custody user Trade Room** (`/trades`; signing live since 10-31, kill switch `RPC_TRADE_ROOM_EXECUTE`) — a signed peer-to-peer trade, not the old custody Trade Hub.

---

## 3. Known issues — by theme

Severity/effort are suggestions. "#" = the item number in `docs/reference/known-issues.md`. **§9 has the verified open/moved status.**

### Launch / activation (the whole critical path)

| # | Issue | Severity | Effort |
|---|---|---|---|
| — | **Traffic / WAU.** External WAU 4 against a 100-WAU gate; buy-link clicks ↑18× MoM; the weekly nudge (5 signed-in) is mostly our own QA. **No outreach** (10-14). | **High** | Medium (assets built, traffic off by directive) |
| — | **Go-live bars.** Accuracy gate: Top Shot MET (series, by-design ~45–46 % leg), All Day short AND slipping. Demand is the binding bar. | High | Mixed |

### Data completeness / accuracy / pricing

| # | Issue | Severity | Effort |
|---|---|---|---|
| 234 | FMV confidence labels are a 30-day sales COUNT, not measured accuracy; the two disagree both ways. New `fmv_accuracy_weekly` instrument; relabel from the 11-09 week (fills 11-16). | **Med–High (open)** | Measurement + relabel |
| 228 | Cold-whale `/api/collection-snapshot` timeouts; index swap + 20 s wait + CDN stale window shipped; still ~4×/24h. | Low–Med (partial) | SQL/stored-snapshot lever |
| 208 | All Day + Golazos ASK_ONLY cap; **EXIT MET 11-05** (ratio 1.008); only the no-history class (a) stays open. | Low–Med (partial) | Left to #234 relabel |
| 209 | Top Shot + All Day STALE cap; basis-line half shipped 10-25; weekly reads still thin. | Low–Med (partial) | Mostly landed |
| 210 | Thin-sale haircut depth floor (0-sale cells 0.75); TS exit met; All Day cut + the depth term itself open (no listing history to backtest). | Low–Med (partial) | Measurement tail |
| 66 | Zero external links (gated on the accuracy gate); code items done; CTR re-read measured 11-05 (not reverting). | Med | Off-platform (not code) |

### Plumbing / instruments

| # | Issue | Severity | Effort |
|---|---|---|---|
| 241 | pg_net 4xx attribution blind to lanes that NULL `request_id` on collect; files 403/429s as "endpoint unknown." Not harmful today. | Low (open) | `pg_net_request_lanes` + join arm |
| 242 | `backfill_pack_rip_metadata` ~19 s fixed cost/call; fails the 50 s budget during IO spells; `p_limit` is not a lever. | Med (open) | Three-file pinned query cut |
| 218 | Dapper Studio pack index froze; Atlas failover + chain-naming of post-freeze packs shipped; upstream freeze is Dapper's. | Low–Med (partial) | Mostly landed |

### Security / operator

| # | Issue | Severity | Effort |
|---|---|---|---|
| 229 | 2026-11-04 CISO audit — remediation mostly shipped (guards, constant-time compares, Dependabot, WAF, MFA, branch protection); rotation TIERS Trevor's. | Med (partial) | Mostly landed + operator |
| 235 | Unnamed multi-region crawler degrades the site ~30 s near 5 PM PT; WAF rule now Challenge (JA4). | Med (open) | WAF tuning + a review 11-13 |
| 60 | Cannot revoke anon/authenticated from net/cron schemas; needs Supabase support. | Low–Med | External |
| 34 | Sentry dark (beacon is detector; 1–3 benign events / 24 h). | Med | Decided (no spend) |

### Tech debt / refactor

| # | Issue | Severity | Effort |
|---|---|---|---|
| 14 / 10 | Monolith page refactor — re-measured this run: DashboardClient **2,966**, SniperClient **2,244**, CollectionAnalyticsClient **2,037**, CollectionTabClient **1,847**, MarketClient **1,383**. | Low–Medium | Large |

### Stalled / scaffolded + deferred hardening

- Cart / Trade Hub / Gifting — **DELETED, verified still absent** (the Trade Room is a separate no-custody signed feature).
- Deferred hardening (intentional): `email_subscribers`/`outbound_clicks`/`portfolio_snapshots`/`support_conversations` public INSERT policies; `user_achievements`+`watchlist_items` still on `owner_key` (text); Golazos `highest_offer` gap SETTLED (no offer source — do NOT build the indexer); `sales-serial-backfill` substring-token check (latent dead code; `INGEST_SECRET_TOKEN` rotation owed); `buildTopshotPoolPayload` fabricated-divisor (latent, no live caller — exit when the pool lane revives, #65); `solUsdOn` historical-vs-spot basis (FIXED 11-03 — `solUsdOnWithBasis()`).

### Architecture notes worth tracking

- **Two "collection vocabulary" and two "confidence vocabulary" footguns** persist by design. Re-read `CLAUDE.md` before any new query. (Note the FMV-count keys use `panini_blockchain`, not `panini`.)
- **Flowty is fully retired (10-30)** — `flowty-proxy` is a 410 tombstone; All Day / Golazos / Pinnacle asks come from Dapper's own storefronts.
- **Supabase compute is `LARGE`** (resized from SMALL 2026-09-20). Any pre-09-20 finding citing the SMALL-tier disk-IO floor (e.g. 22 MB/s) is stale — re-derive.
- **The June ~4.2 GB DB-size baseline doc is badly stale** — the DB now operates at ~42–46 GB on the pg_net sawtooth + Panini growth; reset the baseline.
- **A metadata fix is not a page fix** — verify the rendered BODY, not the `<head>` (the UFC sniper subtitle, 11-05). **A server→client prop must be data, never a callback; a server component importing a VALUE (or calling a FUNCTION) from a `"use client"` module gets a stub**; **a `"use client"` module must never reach `lib/supabase.ts`**; **a query-param toggle cannot change what a crawler sees — one collection, one URL**; **an inline `<style>` reset must sit in `@layer base`** — all green in `tsc`/vitest/lint but only a real render / live request says so; see `architecture-notes.md`.
- **Eight+ caller sources** — including a laptop collector-walk runner and cron-job.org — are invisible to a repo grep. Enumerate all before calling any ingest dead.

---

## 4. Prioritized next actions — **canonical**

`CLAUDE.md`'s old list is replaced by **`docs/strategy/roadmap-2026-10-17.md`** (canonical; accuracy-is-the-gate) and **`docs/strategy/go-live-2026-09.md`**:

| Phase | Action | Status |
|---|---|---|
| Gate | **Accuracy is the GATE — HIGH/MEDIUM share must beat incumbents, read as a series; now also measured against realised sales (`fmv_accuracy_weekly`).** | **Top Shot MET (series; ~45.6 % leg by design); All Day NOT MET (26.8 %) and SLIPPING; Pinnacle 32.7; Panini 45.7. First real accuracy read of the 11-04 fixes = 11-16.** |
| Go-live | **M1–M11 bars.** | Latency/beacon/mobile bars met in prior cycles; accuracy gate met for Top Shot, short for All Day; demand is the binding bar. |
| 1 | **Prove the product with real users — 100+ WAU; no outreach (10-14).** | **Open — the critical path. WAU 4; buy-link clicks ↑18× MoM but authed activation flat and the weekly nudge is QA-confounded. Convert the traffic already arriving; hold outreach.** |
| 2 | Cost / latency / saturation levers. | **Stable — DB ~42–46 GB (Panini + pg_net sawtooth), tier LARGE; reset the stale size baseline doc.** |
| 3 | Durable debt. | Heavy advance — the pricing-accuracy instrument + cap cluster, the CISO audit + remediation, the Candy census, the trophy/challenge arc, identity/search parity. |
| 4 | Chain two, readiness-gated. | Candy LIVE (thin, market frozen; census expanded to 22,127 editions); Panini walked + parity-built; Rewards paused/dial-in. |

**Standing guardrails:** no paywall/Stripe until 100+ WAU; no infra spend pre-revenue; **no outreach** (10-14); **verify pages by rendered DOM, not HTTP 200**; **before gating/short-circuiting any route, enumerate EVERY caller** (eight+ sources).

**Housekeeping still outstanding:** decide the Candy-census `edition_integrity_flags` handling (view edit vs let a hydration lane drain); land the #242 / #228 query cuts (Claude Code); finish the #229 secret-rotation tiers + S1/S3/S6 console tokens + C2 postal address; the ~11-13 #235 WAF review; #58 OpenSea key (~11-27); the ~11-11 `net._http_response` read; convert the arriving traffic (activation); and reset the stale DB-size baseline doc.

---

## 5. In-code TODO inventory

A first-hand scan over tracked non-docs source (`git ls-files` → `*.{ts,tsx,js,jsx,mjs,cjs,sql,toml,css}`, excluding `docs/`; `node_modules`/`.next`/`.git` are untracked-excluded; **6,854** tracked non-docs source files) with `grep -nE '\b(TODO|FIXME|HACK|XXX)\b'` found **6 match lines, none actionable** — unchanged in character from prior weeks. (TODO 5 lines, XXX 2 — both on one format-literal line; FIXME 0, HACK 0.)

### 5a. Narrative / resolved-work references + the format-literal false positive (6 lines)

- `app/api/rtr/lock-roi/route.ts:38` — "v2 folds in the two signals the v1 TODO called out — TIER and SERIAL" (describes resolved work).
- `lib/chains/solana/normalize.ts:48` — "It was previously held as a TODO placeholder…" (resolved).
- `lib/format.ts:6` — the `"$X,XXX.XX" / "-$X,XXX.XX"` format doc comment; the `XXX` here is a format-string literal (twice), the exact false positive the task names.
- `lib/rtr-lock-roi-weights.ts:7` — "resolves the standing 'calibrate the absolute curve' TODO…" (resolved).
- `supabase/migrations/20260713050000_audit_20260713_wmc_team_name_denorm.sql:4` — "Motivation (was a TODO in components/collection/CollectionMomentTable.tsx):" (shipped; past-tense reference).
- `supabase/migrations/20260919173527_panini_bridge_candidates…sql:30` — "each is a pre-flip decision, **not a TODO**" (explicitly not a marker).

> **Net change since last week:** none of consequence. Live application code has **zero actionable** TODO/FIXME/HACK/XXX markers. `scripts/`, `workers/` (non-vendored) and `supabase/functions/` scanned clean. `TODO_`-prefixed launch-flag guard strings (which do not match `\bTODO\b`) persist by design.

---

## 6. Resolved / no action needed

Verified against the register STATUS INDEX, the ledger, the 11-08/11-09 overnight metrics + handoffs, and the monthly review:

**Newly resolved / landed / decided since last week (2026-11-02 → 2026-11-09):**
- **#213** — the #209 STALE cap ignored low-serial sales: SHIPPED for the scope that wins/ties every cell (All Day by circulation), CLOSED 11-05.
- **#221** — wmc player-name spelling variants: CLOSED 11-08 (`heal_wmc_player_names_from_catalog` daily cron; names follow the person).
- **#223** — the cross-collection acquisition quarantine: RESOLVED 11-02 (the SQL-editor paste ran).
- **#225** — UFC Strike video: CLOSED BY DECISION 11-02 (poster-only; no video mirror).
- **#226** — pack dist-from-chain map: CLOSED 11-05 (both exit clauses met; 200/200 chain-verified).
- **#227** — scheduled commercial-send readiness: RESOLVED 11-04 (second clean night; 11-09 first send + 11-08 prune as scheduled checks).
- **#230** — constant-time secret compares: RESOLVED 11-04 (ratchet 37 → 0; part of the CISO pass).
- **#231** — Dependabot HIGH alerts → 0: RESOLVED 11-04.
- **#232** — Atlas backfill seller-relisted sales delete (754 → 0 rows): RESOLVED 11-04.
- **#233** — market-cap 7-day change nets out FMV restatements: RESOLVED 11-04.
- **#236** — Dapper retired Series-1 Top Shot thumbnails (Dame Cosmic): RESOLVED 11-06.
- **#237** — wallet-indexed three-states ("ever walked?"): CLOSED 11-08.
- **#238** — team nicknames in search + resolver (`team_name_aliases`): CLOSED 11-08.
- **#239** — the Dame Time challenge / share-link: RESOLVED 11-07.
- **#240** — a Panini HIGH without a recent sale is not less accurate: CLOSED 11-08 (the defect was concierge wording).

**Note on churn:** the register grew 223 → 240 numbered items in one week (+17), closed +15 (214 → 229), and open+partial rose 9 → 11. A build-and-ship surge (the pricing-accuracy arc, the CISO audit, the trophy/challenge arc, the Candy census), not a discovery of latent defects — most new slots shipped-and-closed in the same window, and the current open set is one measurement/relabel item (#234), one crawler mitigation (#235), two plumbing items (#241/#242), and the accuracy + security partials (#228/#229).

---

## 7. Suggested sequence

A pragmatic order under **accuracy-is-the-gate** + the go-live bars (outreach off, gate 100+ WAU):

1. **Relabel FMV confidence by measured accuracy (#234).** Once the 11-09 week fills (Mon 11-16), make each label's promise match its segment's within ±25 % — this is the "pricing is the anchor" work, and it directly addresses the All Day slip. Keep labels INTERNAL.
2. **Settle the Candy-census `edition_integrity_flags` decision.** Determine whether non-registry Candy collections have a tier/circ/thumbnail source; if structurally absent, exclude those columns from `v_edition_integrity_flags` (view edit, no data change). Do NOT raise the 250 threshold.
3. **Land the pricing/plumbing query cuts (Claude Code):** #242 `backfill-pack-rip-metadata` (precomputed eligibility or slower cadence), the #228 stored-snapshot lever if the CDN window does not hold, and the Candy-census vs label-fill write deconfliction.
4. **Watch the dated proofs:** the #234 accuracy read (~**11-16**), the weekly demand re-read (~**11-12**, split by `metadata.automated`), the #235 WAF review (~**11-13**), the `net._http_response` read (~**11-11**), Candy's honest share fall (~**11-10**), Candy market re-verify (~**11-27**).
5. **Finish the CISO tail (#229):** the secret-rotation tiers + S1/S3/S6 console tokens + C2 postal address (operator/Trevor) — before any marketing.
6. **Convert the arriving traffic (the activation lever)** — a no-login, high-intent anon → wallet-paste → "here's your squeeze / EV / what to chase" path, tuned on wallet_paste and outbound-clicks (both growing); get a clean internal-excluded WAU read each week; hold outreach until the 100-WAU gate opens.
7. **Reset the stale DB-size baseline doc** (~4.2 GB June → operating ~42–46 GB) and keep the `net._http_response` sawtooth + Panini growth on watch.
8. **Finish the pricing-cap tails:** #210 remaining haircut sub-classes, #209 weekly reads — each has a falsifier in its item.

---

## 8. Notes from verification

- **Sandbox / device shell active this run.** `git`/`grep`/`wc`/`ls` all work over the connected repo; counts are first-hand. **1,050 commits** since 2026-11-02 (`git log --since`); mount HEAD `b50e4b281` 2026-11-08 22:27 PST (Trevor). Authors: Claude 842, Claude (Cowork) 93, Trevor 91, rpc-daytime-monitor 12, overnight/context/migration bots ~8. The mount is level with `origin/main` (both `b50e4b281`).
- **Counts measured this run:** CI = **21** jobs under `jobs:` in `.github/workflows/ci.yml` (unchanged: changes, memory-docs, docs-tests, inherited-status, typecheck, eslint-ratchet, cadence-escrow-tests, unit-tests-shard, unit-tests, component-tests-shard, component-tests, workflow-lint, build-render, worker-tests, workers-typecheck, db-tests, ledger-guard, register-guard, inbox-guard, tree-corruption, edge-deno). DB-invariant test files = **295** (`supabase/tests/*.sql`, `ls`, +8); `app/insights/*/page.tsx` = **39** (+1). Monoliths re-measured (`wc -l`): DashboardClient 2,966 / SniperClient 2,244 / CollectionAnalyticsClient 2,037 / CollectionTabClient 1,847 / MarketClient 1,383.
- **Live metrics (from the 2026-11-08 ~1:08 AM PT overnight pass + the 2026-11-09 ~1:05 AM PT pass + the 11-01 monthly review):** DB size **45,643 MB** (~45.6 GB; down from 46,281 — the pg_net sawtooth; operating band ~42–46 GB). Trust (11-08): **0 breaches / 40 legs ok**; (11-09): 3 known-shape dispositioned breaches — `edition_integrity_flags` 20,627 (Candy census fail-safe) + the Candy-closure cluster. `v_fmv_sanity_flags` 0; `topshot_impossible_parallel_serials` 0. FMV HIGH+MED by collection (11-08): Panini 17,998, NBA 6,851, NFL 1,755, Pinnacle 939, Candy 31, Golazos 1, UFC 0. Editions: NBA 14,731, Panini **40,574** (+~400 wk), NFL 6,190, Golazos 575, UFC 617, Candy 125 registry (+ the ~22k non-registry census). Client-error beacon 1–3 benign CSP events / 24 h. Vercel 24 h: 12–32 chronic degrade-to-empty groups, none new, no crash group. Security clean.
- **Accuracy — file-blessed series (roadmap-status 11-07 block, wk 11-02 partial/21–22 legs):** Top Shot 45.6, All Day 26.8, Pinnacle 32.7, Candy 48.1, Panini 45.7, Golazos 0.2, UFC 0.0. Top Shot's ~45–46 % is the FMV 1.8.2 MEDIUM re-grade (by design); All Day is drifting DOWN (27.4 → 27.1 → 26.8). **Read a series, not a leg.** The new `fmv_accuracy_weekly` instrument (#234) first reads the 11-04 fixes in the 11-09 week (fills Mon 11-16).
- **Demand:** monthly (11-01, 30 d) WAU 4, MAU 15, 38 accounts, outbound buy-link clicks 222 (↑~18× MoM), 1 email sub; weekly (10-29..11-04, read 11-07) 69 browsers / 149 visits (mostly our QA — direct 59 → 105), 5 external signed-in (↑ from 2), 1 signup, search flat. Next weekly re-read ~11-12.
- **TODO scan: 6 match lines, 0 actionable** (§5) — tracked non-docs source via `git ls-files` + `grep -nE '\b(TODO|FIXME|HACK|XXX)\b'`; the two `XXX` hits are the `$X,XXX.XX` format literal on one line; the other 5 are past-tense/resolved references. (A whole-tree recursive grep timed out on the mount; the `git ls-files`-scoped scan is the authoritative source-code read.)
- **Deletions verified by absence (`test -e`):** `lib/cart`, `lib/trade-escrow`, `app/dashboard/trade-hub`, `app/dashboard/gift`, `lib/blazers-trivia.ts`, `docs/FREEZE.md` — all absent.
- **Launch flags verified:** `lib/launch-flags.ts` `CANDY_MLB_PUBLIC = true`, `PANINI_PUBLIC = true`; Trade Room kill switch `RPC_TRADE_ROOM_EXECUTE` present (`lib/trade-room/execute.ts`).
- **Cited paths spot-checked — one stale reference found.** Resolve (no issue): `docs/strategy/roadmap-2026-10-17.md`, `docs/strategy/go-live-2026-09.md`, `docs/reference/{known-issues,roadmap-status,architecture-notes,topshot-ownership-index}.md`, `docs/audits/2026-11-04-ciso-security-audit.md`, `docs/operations/secret-rotation-plan-2026-11.md`, `docs/operations/flowty-retirement-runbook.md`, `docs/handoff-2026-11-04-{fmv-confidence-three-migrations,fmv-haircut-stops-at-bid,allday-low-haircut-075,edition-detail-capped-bidfloor}.md`, `docs/strategy/features/pack-ev.md`, `docs/strategy/seo-2026-09-06-search-console-read.md`, `scripts/{qa/mobile-sweep.mjs,demand-read.sql}`, `lib/{api-error,insights/board-status,analytics/fetch-json,og/board-empty-copy,packs/pack-deals,packs/pack-book-source,sniper/header-copy,offers/edition-offer-rows,db/omit-unread}.ts`. ⚠ **Stale:** `docs/proposals/wmc-snapshot-cover-index-swap-STAGED.sql` is cited in **open item #228** but is ABSENT — the index swap it staged was completed via the dashboard on 11-04, so the reference should be marked done in the item. **Correctly absent (not stale):** `docs/pending/142-quarantine-run-in-sql-editor.sql` (the #223 quarantine ran 11-02; the pending file was removed, and no open item cites it).
- **Known-issues STATUS INDEX:** its own generated line reads **240 numbered items — 4 open · 7 partial · 229 closed**; the 4 open are **#234, #235, #241, #242**; the 7 partial are **#66, #208, #209, #210, #218, #228, #229**; the newest filed slot is **#242**.
- This report did **not** edit `CLAUDE.md` or any source file and did **not** touch git — it only created this file.

---

## 9. Known-issues reconciliation (verified 2026-11-09)

The register's own generated STATUS INDEX reports **240 numbered items — 4 open · 7 partial · 229 closed**. ⛔ `closed`/`open` means the item *says* so — read its own date stamp. The current open/partial set and the items that moved since last week:

| # | Issue | Index status | Verified status | Evidence |
|---|---|---|---|---|
| 234 | FMV confidence labels are a 30-day sales count, not measured accuracy | 🟡 **open** | NEW 11-04 — `fmv_accuracy_weekly` instrument built (TS jobid 828, All Day 829); relabel from the 11-09 week (fills 11-16) | known-issues #234 |
| 235 | Unnamed multi-region crawler degrades the site ~30 s near 5 PM PT | 🟡 **open** | NEW 11-06 — WAF "Entity page sweep" rule (JA4) switched Log → Challenge 11-08; review 11-13 | known-issues #235 |
| 241 | pg_net 4xx attribution blind to request_id-NULLing lanes | 🟡 **open** | NEW 11-08 — not harmful today; `pg_net_request_lanes` + join arm proposed | known-issues #241 |
| 242 | `backfill_pack_rip_metadata` ~19 s fixed cost; 50 s budget fails under IO spells | 🟡 **open** | NEW 11-08 — three-file pinned query cut needed (Claude Code); spell-free hours still succeed | known-issues #242 |
| 66 | SEO / zero external links | 🟠 partial | Code done; CTR re-read measured 11-05 (not reverting); external links Trevor's, gated | known-issues #66 |
| 208 | All Day + Golazos ASK_ONLY cap | 🟠 partial | **EXIT MET 11-05** (ratio 1.008, within ±25 % 44.2); only the no-history class (a) open | known-issues #208 |
| 209 | Top Shot + All Day STALE cap | 🟠 partial | Price + basis-line halves shipped; weekly reads still thin | known-issues #209 |
| 210 | Thin-sale haircut depth floor | 🟠 partial | TS exit met; All Day cut + depth term open (no listing history to backtest) | known-issues #210 |
| 218 | Dapper Studio pack index froze | 🟠 partial | Atlas failover + chain-naming of post-freeze packs shipped; upstream freeze is Dapper's | known-issues #218 |
| 228 | Cold-whale `/api/collection-snapshot` timeouts | 🟠 partial | NEW 11-03 — index swap + 20 s wait + CDN stale window shipped; still ~4×/24h | known-issues #228 |
| 229 | 2026-11-04 CISO security audit | 🟠 partial | Remediation mostly shipped (guards, constant-time, Dependabot, WAF, MFA, branch protection); rotation tiers Trevor's | known-issues #229 |
| 213 | #209 STALE cap ignored low-serial sales | ✅ closed | CLOSED 11-05 (shipped for the scope that wins/ties every cell; was open last week) | STATUS INDEX |
| 221 | wmc player-name spelling variants | ✅ closed | CLOSED 11-08 (daily heal cron; was open last week) | STATUS INDEX |
| 223 | cross-collection acquisition quarantine | ✅ closed | RESOLVED 11-02 (SQL-editor paste ran; was open last week) | STATUS INDEX |
| 225 | UFC Strike video gateway-bound | ✅ closed | CLOSED BY DECISION 11-02 (poster-only; was open last week) | STATUS INDEX |
| 226–227, 230–233, 236–240 | pack-dist map / commercial-send readiness / the 11-04 CISO cluster / trophy + Dame Time / identity / Panini-HIGH | ✅ closed | all resolved/decided in-window | STATUS INDEX |

**Tally (per the register's own STATUS INDEX):** **240 numbered items — 4 open · 7 partial · 229 closed**, newest slot **#242**. Plus the go-live plan, the per-collection accuracy legs, Candy live (market frozen, census expanded) + Panini walked & parity-built + the collector-utility layer + trophy challenges + Rewards paused, **21-job CI**, **295 DB-invariant test files**, and **39 public `/insights` surfaces**.

**Bottom line for `CLAUDE.md`:** another very heavy, clean week (1,050 commits), all interactive Cowork / Claude Code, with the autonomous pass green-and-idle every night. The arcs this week were **pricing accuracy as the anchor** (the #234 `fmv_accuracy_weekly` instrument + the 11-04 cap cluster — first real read 11-16), a **full CISO security audit and remediation** (#229 — guards, constant-time compares, Dependabot, WAF, MFA, branch protection shipped; rotation tiers Trevor's), a **large Candy census** (editions 125 → 22,127, a fail-safe `edition_integrity_flags` gate now queued for a view-edit decision), and a **trophy/challenge arc** (Dame Time cases, "Fill my case"). Open+partial rose **9 → 11**, and both founder-only residues that topped last week's list (**#223**, **#225**) closed, alongside **#213**, **#221** and the whole 11-04 audit cluster. Live user-facing trust metrics are clean (0 impossible serials, 0 FMV sanity flags); the three standing breaches are known-shape and dispositioned. On the front page, **Top Shot is MET on its series (~45.6 % leg by design), All Day is short AND slipping (26.8 %, -0.3/wk)**, DB is ~45.6 GB on legitimate Panini growth + the pg_net sawtooth, and **demand is still the one number that decides everything** — WAU 4 against a 100-WAU gate with outreach off, the latest weekly nudge mostly our own QA traffic. The standing asks are operator/Trevor: the **#229** secret-rotation tiers (+ S1/S3/S6, C2), the Candy-census `edition_integrity_flags` decision, the **#242/#228** query cuts (Claude Code), the ~11-13 **#235** WAF review, and converting the arriving traffic into returning authed users.
