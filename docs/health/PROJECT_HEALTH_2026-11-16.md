# Rip Packs City — Project Health Report

**Date:** 2026-11-16
**Compiled by:** Claude (Cowork) — automated weekly run
**Sources:** `CLAUDE.md` + `docs/reference/known-issues.md` (generated STATUS INDEX, now reading **257 numbered items — 10 open · 6 partial · 241 closed**, newest slot **#259**), the canonical forward plan `docs/strategy/roadmap-2026-10-17.md`, `docs/reference/roadmap-status.md` (the 11-07 headline-metric block, the 11-04 price-accuracy block + its 11-12 addendum, the 11-13 demand re-read of PT week 11-05..11-11, the 11-10 off-cycle activity review, and the "Decisions taken" / "Open items" / "Needs Trevor" ledgers), `docs/reference/architecture-notes.md`, `docs/overnight/metrics-latest.json` (the 2026-11-16 ~1:11 AM PT overnight pass) plus the 2026-11-16 ~9:14 AM PT mount HEAD for the most recent live read, and first-hand file-tool + shell scans over the connected repo (`git`, `grep`, `wc`, `ls`) at ~03:10 AM PT.
**Scope:** A single consolidated, themed view of open work — the numbered known-issue slots (`#0–#259`), the go-live framing, the prioritized actions, the overnight operational queue, and the in-code marker inventory — with suggested severity, effort, and a recommended sequence.
**Prior report:** `PROJECT_HEALTH_2026-11-09.md` (7 days ago). This regeneration mirrors its structure. `_2026-11-02.md` … `_2026-05-22.md` (twenty-seven earlier reports) also live in `docs/health/`.

> **Biggest change since 2026-11-09 — the week the DAME TIME CHALLENGE moved demand for the first time, with the pricing-accuracy and Candy-data-quality arcs running alongside.** The week shipped **1,032 commits since 11-09** (about level with last week's 1,050, another very heavy week), again almost all interactive Cowork / Claude Code — the autonomous pass stayed green-and-idle every night (the 11-16 pass shipped 0, reverted 0). The dominant workstreams were (1) **the Dame Time challenge + instant giveaway delivery, which produced the first real demand surge in this project's history** — the weekly demand read for PT week 11-05..11-11 jumped to **35 external signed-in users (from 5), 20 signups (from 1), and 27 challenge cases (all completed)**, and the vault-backed instant-delivery path was **proven live on 11-10** (the Dame Time reward drop delivered Moments to winners' wallets within seconds); (2) **the pricing-accuracy relabel arc (#234)** — the relabel RULE was decided (a segment earns the label its measured within-±25 % share justifies, and the earliest relabel is after the Mon 11-23 `fmv_accuracy_weekly` run), plus a second round of thin-tail FMV work on 11-12 (comparable-edition estimates for unpriced Top Shot / All Day / Golazos editions); (3) **a large Candy data-quality cleanup** — the census integrity gate that read **20,627 last week fell to 8** (#246 resolved: the census now fills, retires and re-points keys), but the same deep look surfaced a cluster of new Candy edition-keying defects (#256–#259); and (4) **a heavy Panini walk** — editions grew **40,574 → 47,674 (+~7,100)**, the main durable DB-size driver. The register grew **17 slots (#243–#259)** and **closed +12 (229 → 241)**; open+partial moved **11 → 16**. Three of last week's open/partial items closed (**#208**, **#241**, **#242**); **#190 reopened** (Trevor bought the Dune Analytics connector, so the pre-2023 custodial pack-open gap is addressable again). The current open set is Candy data-quality (#256–#259), the FMV relabel (#234), the Tencent crawler (#235), two instrument/cost items (#248, #253), one ISR-cache correctness item (#249), and the pre-2023 pack-open lane (#190), plus six partials.

> **Overnight reality — GREEN and idle by design, again, every night this week.** The 2026-11-16 ~1:11 AM PT pass (Cowork cloud, push-capable via the VM route, no `FREEZE`) **shipped nothing** and logged a quiet, healthy night: every live inbox candidate was already resolved by the 11-15 Claude Code sessions, owned by another scheduled task (the **#248** close-out, scheduled 11-16 10:20 AM PT), or a read-only product decision for Trevor. Security scans clean on all four arms; **1 trust breach** (`candy_sales_stale_hours` 38.7 h — the Candy market has been closed since 10-11, no user impact, dispositioned). The week's shipping was all interactive Cowork / Claude Code sessions.

> **Traction reality — the first week BOTH acquisition and activation moved, carried by the Dame Time challenge.** The latest weekly demand read (PT week 11-05..11-11, `scripts/demand-read.sql`, read 11-13) shows **252 human browsers / 538 visits** (69 / 149 the week before, 580 crawler-burst visits excluded), **35 external signed-in users** (up from 5), **20 signups** (up from 1), **27 challenge cases created, all 27 completed**, and X as the top new acquisition surface (5 → 86 visits), with the challenge board the top sign-in surface (10 clicks). ⚠ Search still did not grow (Google 20 → 12 landings) and `direct` is still an upper bound (a slow tail of the 11-09 crawler leaks ~79 lone `/panini-blockchain/*` landings past the exclusion rule). The honest test is the **next re-read (~11-19)**, the first full week AFTER the challenge locked on 11-10: whether the 20 new signups return. ⚠ The user gate is **100 WAU**; outreach is still off by directive (10-14). This is the strongest demand signal to date — but it came from a one-time event, and durability is unproven.

> **Accuracy gate — read the series, not the leg; the 11-07 legs are the latest file-blessed read (now 9 days old; no FMV route change shipped this week).** File-blessed weekly-mean legs (`rpc_trust_health_history`, roadmap-status 11-07 block, wk 11-02 partial): **Top Shot (M1) 45.6 %** (🔴 under its 50 % bar *by decision* — the FMV 1.8.2 MEDIUM re-grade; read as a series), **All Day (M2) 26.8 %** (🔴, drifting DOWN ~0.3/wk; 3.2 under its bar), Pinnacle **32.7 %** (own leg, never averaged), Candy **48.1 %** at the 11-02 read but ⬇ **the frozen-market window has now drained** — live FMV HIGH+MED Candy is **2** (MEDIUM 2 / LOW 420 / STALE 1,679), as predicted ~11-11, Panini **45.7 %** (flat), Golazos **0.2 %**, UFC **0.0 %** (closed-market sentinel). ⭐ **The 11-04 / 11-12 price changes move PRICES, not labels, so they cannot move these shares** — their effect is read in `fmv_accuracy_weekly` (#234), whose first post-change window (the 11-09 week) first fills **Mon 11-16**, and the **earliest relabel is after the Mon 11-23 run** (two post-11-04 weeks must agree on the band). Top Shot baseline (wk 10-26, within ±25 %): ALL 68.2 · HIGH 74.3 · MEDIUM 69.1 · LOW 54.9 · ASK_ONLY 48.6.

> **Cost / storage — ~53.9 GB, up ~8 GB on the pg_net sawtooth + a heavy Panini walk.** Live read: DB **53,881 MB (~53.9 GB)** at the 11-16 1:11 AM pass (up from 45,643 MB last week and 52,838 at the prior overnight read — the documented `net._http_response` TOAST sawtooth plus real growth). The operating band has stepped up to **~52–54 GB**. Durable growth is Panini: editions **47,674 (+~7,100 week-over-week — a very heavy collector-walk week)**, `panini_card_serials` remains the main DB-size driver. `net._http_response` is **heap 11 MB + TOAST 3,410 MB** within its ~6 h TTL (healthy, not a leak — the pass notes the prior "677 MB" figure conflated heap/toast and corrects the method). Compute stays **LARGE** (resized 09-20). ⚠ The ~4.2 GB June DB-size baseline doc remains **badly stale** — the real operating baseline is now ~52–54 GB; resetting it so it stops reading as a ~13× regression is still an open housekeeping item.

> **Platform context.** Top Shot's public REST API stays dead; the Atlas backend is the feed and answers a Cloudflare 403/404 on some lanes by design (self-healing; the chronic Atlas lanes account for the bulk of the pg_cron fail counts, all attributed with fresh 200s and 0 catalog staleness). **Flowty stays RETIRED (10-30)** — `flowty-proxy` is a 410 tombstone; All Day / Golazos / Pinnacle asks come from Dapper's own storefronts. **Candy/Solana is LIVE but its market has been frozen since 2026-10-11** — `candy_sales_stale_hours` (38.7 h on the 11-16 pass, a redesigned leg) is the honest downstream symptom of a real dead market (#58), dispositioned, not a new defect; the OpenSea revisit is ~11-27. The Candy census integrity gate **cleared this week** (`edition_integrity_flags` 20,627 → 8). NFL All Day secondary-market only. UFC Strike Flow market frozen (0 sales; honestly labelled). Panini = WC Prizm + basketball plane (`PANINI_PUBLIC = true`); the collector-walk runs on Trevor's laptop. **Giveaway instant delivery is LIVE and proven** (vault `0x38300125d58f76d1`, `RPC_GIVEAWAY_INSTANT_DELIVERY=1`). **Dune Analytics connector bought 11-14** (4,000 credits/mo) — reopens #190.

> This is a snapshot. `CLAUDE.md` + `docs/reference/known-issues.md` are the source of truth for project memory; `docs/overnight/` for what shipped; `docs/strategy/roadmap-2026-10-17.md` for the plan. This doc reorganizes them for triage. **Severity and effort tags throughout are suggestions, not gospel.**

> **Report location stays clean.** All reports (this one included) live in `docs/health/`; the repo root holds none (verified this run).

---

## 1. At a glance

| Bucket | Count | Notes |
|---|---|---|
| Known-issue slots tracked | **#0–#259** | Register STATUS INDEX: **257 numbered items — 10 open · 6 partial · 241 closed**. 17 new slots (#243–#259) since last week. See §9. |
| Known issues — resolved/closed since last week | **+12 net** | Closed count rose 229 → 241. Moved off the open/partial list: #208, #241, #242 (closed) — plus the new #243–#255 that shipped-and-closed in-window. See §6 / §9. |
| Known issues — open / partial | **16** | **10 open** (#190, #234, #235, #248, #249, #253, #256, #257, #258, #259) + **6 partial** (#66, #209, #210, #218, #228, #229). Up from 11 last week. — §3 / §9 |
| Known issues — 🚨 live trust breach | **0 user-facing** | On the 11-16 pass: 1 known-shape **dispositioned** breach — `candy_sales_stale_hours` 38.7 h (Candy market closed since 10-11, no user impact). `topshot_impossible_parallel_serials` 0; `v_fmv_sanity_flags` 0; `edition_integrity_flags` **8** (bar 250). — §2.4 |
| Known issues — needs Trevor, operator | **few** | **#229** secret-rotation tiers (MFA/WAF/branch-protection/Dependabot all done); the **#256** OpenSea capture (`OPENSEA_API_KEY`, Vercel-only); **#190** Cloudflare worker secret for the Dune lane; **#58** OpenSea key (~11-27); **#66** external links (gated); C2 postal address; S1/S3/S6 console token rotation; #22 Dapper session rotation. — §2.6 |
| Known issues — carried shelved | **~1** | **#58** OpenSea key — the 3 candy-opensea lanes stay unscheduled; only a Trevor-set key would resume the Candy book, if ever wanted (re-verify ~11-27). |
| Known issues — removed from the tree by decision | 3 | #1 Cart, #3 Trade Hub, #3b Gifting — DELETED (read-only pivot). Verified still absent this run. |
| Go-live plan | **M1–M11 + B1–B5** | `docs/strategy/go-live-2026-09.md`. Accuracy gate: Top Shot met (series, by-design ~45–46 % leg), All Day short and slipping. Demand is the binding bar. — §2.1 |
| Commits since last report | **1,032** | `git log --since 2026-11-09` on the connected mount. Authors: Claude 896, Trevor 72, Claude (Cowork) 22 (+1 QA), rpc-daytime-monitor 21, overnight/migration bots ~20. Mount HEAD `4029d240b` 2026-11-16 09:14 (rpc-overnight); mount is level with origin. |
| Accuracy gate (headline metric) | **Per-collection, weekly-mean legs (11-07 read, 9 d old)** | Top Shot **45.6 %** (by-design 1.8.2 re-grade; read as a series), All Day **26.8 %** (NOT MET, drifting DOWN), Pinnacle 32.7, Candy 48.1 → drained (live FMV HIGH+MED 2), Panini 45.7, Golazos 0.2, UFC 0.0 (sentinel). Not re-measured this week (no FMV route change). — §2.1/§2.3 |
| Price accuracy (the second number) | **`fmv_accuracy_weekly` — first post-change read fills Mon 11-16** | Measures sales vs the price published ≥ 1 d before (#234). TS baseline wk 10-26 within ±25 %: ALL 68.2 / HIGH 74.3 / MED 69.1 / LOW 54.9 / ASK_ONLY 48.6. Relabel RULE decided; earliest relabel after Mon 11-23. — §2.3 |
| Demand (the critical-path number) | **first real surge — but event-driven** | Weekly (11-05..11-11): **252 browsers / 538 visits, 35 signed-in (↑ from 5), 20 signups (↑ from 1), 27 challenge cases.** Gate **100+ WAU**; **no outreach** (10-14). Next re-read ~11-19 = durability test. — §2.1 |
| Open overnight operational items | **standing queue** | #248 wmc-fmv reconcile cost close-out (scheduled 11-16 10:20 AM); #253 `refresh_panini_sale_feed_status` timeout; #259 Candy multi-mint re-key (draining); #256 Candy OpenSea capture; #58 OpenSea (~11-27). — §2.6 |
| Net-new structural workstream | 2 live + utility layer + giveaways | Candy/Solana LIVE (thin, market frozen; census integrity gate cleared) + Panini (WC Prizm + basketball, heavy walk, 47,674 editions); plus the collector-utility layer (Trade Room, trade-in finder, follows, checklists, trophy challenges) and **live giveaway instant delivery**. — §2.8 |
| Prioritized next actions | **canonical** | `roadmap-2026-10-17.md` (accuracy-is-the-gate) + `go-live-2026-09.md`. Gate: **100+ WAU**, no outreach, no infra spend pre-revenue. See §4. |
| In-code TODO markers | **0 actionable** | Measured this run (`git ls-files` + `grep`): **6** match lines, all narrative/false-positive (incl. the `$X,XXX.XX` literal). — §5 |
| Test / DB-invariant pins | **314 `supabase/tests/*.sql` files** | +19 vs last week's 295 (measured this run, `ls`). |
| CI jobs (ci.yml) | **21** | Measured this run under `jobs:` — unchanged from last week (same 21). See §8. |
| Public `/insights` surfaces | **39** | Measured this run: 39 `app/insights/*/page.tsx` dirs (unchanged). |
| Active revenue-blocking items | 0 | By decision — monetization tabled until 100+ WAU. |

**Health read:** Another very heavy, clean shipping week — 1,032 commits, almost all interactive, the autonomous pass green-and-idle every night. The headline is a genuinely new signal: **the Dame Time challenge produced the first week where acquisition AND activation both moved** (20 signups, 35 signed-in, 27 completed challenge cases), and the giveaway instant-delivery rail that makes such events repeatable was proven live. The register's open work grew more than usual (11 → 16), but the shape is mostly a concentrated, healthy **Candy data-quality cleanup**: the deep census pass cleared the 20,627-flag integrity gate (#246) and in doing so surfaced a cluster of edition-keying defects (#256 OpenSea capture, #257 legacy asks, #258 namesake, #259 multi-mint merge — the last already shipping a fix and draining). The concentrated risk is unchanged in shape: **(1) demand durability** — this week's surge was event-driven, and the ~11-19 re-read is the honest test of whether the new users return (external WAU against a 100-WAU gate with outreach off); **(2) All Day accuracy** — M2 remains short of its bar and slipping (26.8 %, -0.3/wk), and the relabel that could move it is gated on the 11-23 accuracy read; and **(3)** DB growth — ~53.9 GB and climbing ~8 GB/wk on the Panini walk + the pg_net sawtooth. Live user-facing trust metrics are clean (0 impossible serials, 0 FMV sanity flags, integrity flags back to 8); the one standing breach is the known-shape Candy closure.

### Themes

| Theme | Items |
|---|---|
| **Launch / activation (the whole critical path)** | Public + self-serve. **Demand surged on Dame Time** (35 signed-in, 20 signups, 27 challenge cases) but event-driven; durability test ~11-19. Gate **100+ WAU**, **outreach off** (10-14). (§2.1) |
| **Dame Time challenge + giveaway instant delivery (the week's biggest arc)** | Vault-backed instant delivery proven live 11-10 (Dame Time reward drop); per-drop pack themes + opening sounds; the challenge board is now the top sign-in surface. (§2.1/§2.8) |
| **Pricing accuracy — "the anchor of everything"** | #234 relabel RULE decided (segment measured within-±25 earns the label; earliest relabel after Mon 11-23); 11-12 comparable-edition estimates for unpriced editions; #208/#209 price halves resolved. First `fmv_accuracy_weekly` post-change read fills Mon 11-16. (§2.3) |
| **Candy data-quality cleanup (new structural)** | Census integrity gate cleared (`edition_integrity_flags` 20,627 → 8, #246). New: #259 multi-mint merge (3,857 over-circ serials, fix shipped + draining), #256 OpenSea capture, #257 legacy asks, #258 namesake. (§2.3/§2.6) |
| **External crawler sweep (#235)** | A multi-region fetcher (Tencent Cloud ASN) swept hundreds of entity pages; BOTH WAF rules now live — `Entity page sweep` (JA4, Challenge) + a Tencent-ASN Challenge. The crawler has tapered; week-2 read-only check 11-20. (§2.5) |
| **Pre-2023 custodial pack opens (#190 reopened)** | Trevor bought the Dune connector; 201,255 Top Shot moments lack an acquisition row and could now be classified from `flow.cadence_events`. Blocker: the Dune→DB worker lane needs `CLOUDFLARE_API_TOKEN` set. (§2.3) |
| **Identity / search parity** | Candy namesake disambiguation (#258), multi-mint key integrity (#259), the Panini profile picker (#243 resolved). (§2.3) |
| **Live trust — user-facing CLEAR; one dispositioned known-shape breach** | `topshot_impossible_parallel_serials` 0; `v_fmv_sanity_flags` 0; `edition_integrity_flags` 8; the lone breach is `candy_sales_stale_hours` (market closed). (§2.4) |
| **Pricing-tier caps (carried partials)** | #209 STALE (TS + All Day); #210 thin-sale haircut depth floor — each a partial with a weekly tail (§2.3) |
| **ISR failed-render caching (#249)** | A failed pack-dist / entity-page render is stored by ISR and served for the whole revalidate window; #33-class, per-page. Measure-first before a segment-semantics fix. (§2.3) |
| **Instrument cost (#248, #253)** | #248 wmc-fmv reconcile estate-wide IO cost (close-out scheduled 11-16); #253 `refresh_panini_sale_feed_status` killed ~once/day by random heap fetches over 4.79M unsold serials. (§2.6) |
| Security | scans clean; user-facing trust clear; CISO remediation mostly shipped; one more dead credential found + neutralized (`GITHUB_ACTIONS_READ_TOKEN`); #60 (can't revoke anon from net/cron schemas) carried, needs Supabase support (§2.4) |
| Product simplification — READ-ONLY pivot | Cart / Trade Hub / Gifting **DELETED** — verified still absent. (The Trade Room is no-custody, signed, user-to-user; its race conditions closed by row-locking fns, #250.) (§2.9) |
| SEO | #66 — code items done; external links remain Trevor's, gated, now with a measurable re-open trigger (Top Shot HIGH ≥ 75 % within ±25 for two weeks). (§2.3) |
| Tech debt / refactor | Monoliths re-measured: DashboardClient **3,108** / SniperClient **2,362** / CollectionAnalyticsClient **2,043** / CollectionTabClient **1,907** / MarketClient **1,398** (§3) |
| DB-size baseline | The June ~4.2 GB baseline doc is still stale; operating ~52–54 GB on the pg_net sawtooth + a heavy Panini walk. Reset it (§2.6) |
| Deferred hardening (intentional) | Public INSERT-policy tables; `owner_key`→`user_id`; Golazos `highest_offer` gap (settled); `INGEST_SECRET_TOKEN` rotation owed; `buildTopshotPoolPayload` fabricated-divisor (latent, no live caller) |

---

## 2. Critical path — start here

Go-live is **operationally done** (public + self-serve). The forward plan is **`docs/strategy/roadmap-2026-10-17.md`** (canonical; accuracy is the GATE, headline metric is the HIGH/MEDIUM confidence share read as a series) plus **`docs/strategy/go-live-2026-09.md`** (what "through the gate" means in numbers). The binding user bar is **100+ WAU** (raised from 50 on 09-25), and **outreach is off** (Trevor, 10-14).

### 2.1 Launch + activation — the first real demand surge, carried by Dame Time; durability unproven — `Severity: High · Effort: Medium (built + measured, no outreach by directive)`

Read-only tabs are anonymous for the published Flow collections (+Candy overview, +Panini); cost-basis/P&L, saved wallets, watchlist, `/dashboard/*`, the Trade Room, and every mutation stay behind sign-in.

- **Weekly demand read (PT week 11-05..11-11, `scripts/demand-read.sql`, read 11-13):** **252 human browsers / 538 visits** (580 crawler-burst visits excluded), **35 external signed-in users** (up from 5), **20 signups** (up from 1), **27 challenge cases created, all 27 completed**, **121 wallet pastes** (22 browsers, from 37/6), **46 magic-link requests carrying a challenge** (from 2). Acquisition this week was **X (5 → 86 visits) + direct (the challenge)**, not organic — the challenge board is the top sign-in surface (`challenge_board_signup` 10 clicks). ⚠ Search still did not grow (Google 20 → 12, ChatGPT 15 → 13). ⚠ `direct` (424) is an upper bound: a slow tail of the 11-09 crawler leaks ~79 lone `/panini-blockchain/*` landings past the hour×section ≥ 8 exclusion.
- **Off-cycle activity review (11-03..11-09, read 11-10):** confirms the same population by the same instrument — 33 signed-in, 17 signups, 26/26 challenge cases; of the 19 who signed up through 11-10 1:40 PM PT, **9 came back on a second day** (the early retention signal), and 6 of 19 never made a trophy case.
- **Giveaway instant delivery — PROVEN LIVE 11-10:** the Dame Time reward drop (`dame-time-challenge-reward-pack`, 27 packs × 2, finishers-only) had 16 of 27 packs claimed, **every one delivered by the vault within seconds and cached named in the winner's wallet**. The rail that makes repeatable reward events possible is now exercised end-to-end.
- **Accuracy (weekly-mean legs, roadmap-status 11-07 block — latest file-blessed, 9 d old):** **M1 Top Shot 45.6 %** (under 50 % *by decision* — the 1.8.2 MEDIUM re-grade), **M2 All Day 26.8 % (≥ 30 % — NOT MET, drifting DOWN ~0.3/wk)**, Pinnacle 32.7, Candy 48.1 → drained, Panini 45.7, Golazos 0.2, UFC 0.0 (sentinel). ⚠ Read the series, not the leg.

The critical-path read is now the most interesting it has been: for the first time an on-platform event (the Dame Time challenge, free pack reward, delivered instantly) moved both acquisition and activation off their floor. But the surge is **event-driven and one-time** — the challenge locked 11-10 — so the single most important line in the next report is the **~11-19 weekly re-read**, the first full week after the lock, measuring whether the 20 signups become returning authed users. If they do, the activation lever (convert arriving/one-time traffic into retained WAU) has its first proof; if they churn, the lesson is that events spike but do not retain. Hold outreach until the 100-WAU gate opens. **All Day's accuracy slip remains the secondary watch:** M2 is short of its bar and slipping, and the lever (the #234 relabel) cannot land until two post-11-04 accuracy weeks agree (earliest after the Mon 11-23 run).

### 2.2 Public intelligence surfaces — 39 public — `Severity: n/a (shipped) · context`

All 39 built surface dirs in `app/insights/` are public (measured this run: 39 `page.tsx`, unchanged). The per-collection squeeze split persists so a crawler/unfurler sees the right collection (the 10-27 architecture note). Carried honesty risks `#50` (`/insights/pack-reality` ranker) and `#33`-class (ISR bakes a failed read into the `revalidate` window — now also tracked as the per-page **#249**) remain as standing design considerations.

### 2.3 Data-intelligence — the pricing-accuracy relabel + the Candy data-quality cleanup — `Severity: Medium (correctness) · Effort: mixed`

**FMV HIGH/MEDIUM counts (11-16 overnight pass):** Panini 20,428 (HIGH 2,286 + MED 18,142), NBA Top Shot 7,026 (HIGH 1,547 + MED 5,479), NFL All Day 1,784 (HIGH 305 + MED 1,479), Pinnacle 991 (HIGH 244 + MED 747), Candy 2 (the frozen window has fully drained — LOW 420 / STALE 1,679), Golazos 1, UFC 0 (closed-market honest label; STALE 582 / NO_DATA 43).

**Shipped / landed since last week:**

- **The #234 relabel rule is DECIDED (11-13).** A segment (confidence × last-sale age × 90-d depth) takes the label its MEASURED within-±25 % share earns — HIGH ≥ 70 %, MEDIUM 60–70 %, LOW 50–60 %, below 50 % the lowest tier — only with n ≥ 200 in the segment, and only once TWO post-11-04 weeks agree on the band (the 11-09 and 11-16 weeks; earliest relabel after the Mon 11-23 run). The relabel moves only the label, never the price, and stays internal (Concierge rule 3). All Day's accuracy job (`rpc-fmv-accuracy-weekly-allday`, jobid 829) already exists and has written the 10-26 and 11-02 weeks.
- **A second round of thin-tail FMV work (11-12).** Comparable-edition estimates for unpriced editions (Top Shot / All Day / Golazos); All Day thin prices capped at the estimate and floored at the best open offer. Each decided on a backtest (Project `claude/fmv-engine-open-items-2026-11-12.md`).
- **The Candy census integrity gate CLEARED (#246, 11-12).** `edition_integrity_flags` 2,660 → 187 → 34 → **8**: the census now fills tier/circ/thumbnail, retires stale rows, and re-points keys. The prior week's 20,627-flag fail-safe is resolved.
- **Panini profile picker (#243 resolved 11-10).** The largest linked Panini profile (6,023 cards) answers the picker's Panini player search in ~4.4 s cold / 0.16 s warm.
- **Pack-metadata query cut (#242 resolved 11-10).** `backfill-pack-rip-metadata` went from 40–50 s with 6/15 timeouts to 25/25 hourly runs ok, max 23 s, avg 10.9 s.

**New / open:**

- **`#234` — relabel from measured accuracy (OPEN).** Rule decided; waiting on the Mon 11-23 `fmv_accuracy_weekly` run (the first week the 11-09 and 11-16 post-change windows can agree on a band). Handoffs: `docs/handoff-2026-11-04-*`.
- **`#190` — pre-2023 custodial pack opens, REOPENED 11-14.** Trevor bought Dune Analyst (4,000 credits/mo) and connected the Dune connector; the first use recovered every pre-index Flowty loan default for tracked lenders. The gap re-measured: 56 saved wallets hold 305,985 Top Shot moments, **201,255 with no `moment_acquisitions` row** and 24,812 gift/unknown with no price. Dune `flow.cadence_events` can classify each from its last deposit tx. **Blocker:** ~226k result rows need the Dune→DB lane, and `workers/dune-proxy` only runs its allowlisted queries; `workers-deploy.yml` needs the `CLOUDFLARE_API_TOKEN` repo secret (never set). **Trevor step:** set that secret, or add the query id to the worker var in the Cloudflare dashboard.
- **`#256` — Candy OpenSea sales are not captured at all (OPEN, needs Trevor).** `sales` holds 0 Candy `marketplace='opensea'` rows (11,117 Magic Eden rows); the plan is an on-chain capture starting at OpenSea's Solana launch (08-31), keyed off each order's `protocol_address` to avoid double-counting Magic Eden settlements. **Needs `OPENSEA_API_KEY`** (Vercel-only).
- **`#257` — legacy Candy asks feed the FMV ask cap; "editions with a sale but no FMV" is the new coverage alert (OPEN, watching).** The legacy-listings lane is verified live (`candy-collections-market`, 6,622 active listings); ⚠ watch that a delisted legacy ask is ever retired (`listings_retired` read 0 on every run so far).
- **`#258` — Candy namesake collision (OPEN, watching).** Two "Luis Garcia" players now have two URLs after `20261115180005`; today's 12 editions are correct, but `link_editions_to_players_by_name` would link a FUTURE "Luis García" Nationals card to the Astros row. A watch query must stay empty; fix (team-aware name arm) only if it fires.
- **`#259` — Candy MULTI-mint editions merge different cards (OPEN, fix shipped + draining).** 90 editions merged different cards (42,592 holdings, 3,857 with a serial above the edition's circulation — the `serial_number > circulation_count` tell). Fix shipped 11-15 (`79c7bcece` + `20261116043431`): the census re-reads each listed card, re-keys it, and its sales follow. Progress 11-15 9:12 PM: editions 90 → 86 (→ 63 by the 11-16 pass), over-circ cards 3,857 → 2,400; ~450 re-reads per hourly run, ~1–2 days to drain. **Close when** the re-measure SQL reads 0 editions.
- **`#249` — ISR caches a FAILED render for its whole window (OPEN, #33-class).** `pack/dist/[distId]` and every ISR entity page (`player`/`set`/`series`/`teams`/`players`) store a "Couldn't load" view when a detail read fails, serving it for up to 10 min. **Measure first** (count `[pack-detail]`/`PackUnavailable` failures in 7 d of Vercel logs — 1–2 per panel per 48 h at the 11-14 read); then either close as not-worth-it or ship a preview-verified fix where a failed regeneration keeps the last good render.
- **`#209 / #210` — pricing-cap partials (carried).** #209 (TS + All Day STALE cap): price + basis-line halves shipped; weekly reads still thin. #210 (thin-sale haircut depth floor, 0-sale cells 0.75): Top Shot exit met; All Day cut + the depth term itself stay open (no listing-history input to backtest a real depth term).
- **`#66` — SEO (PARTIAL, needs Trevor):** every code item done; the edition-title CTR re-read measured 11-05 (not reverting). External links held by the accuracy gate, now with a measurable trigger: **re-open when `fmv_accuracy_weekly` shows Top Shot HIGH ≥ 75 % within ±25 for two consecutive weeks.**

### 2.4 Security, confidentiality + test infrastructure — `Severity: Medium (clean scans; 0 user-facing breaches) · Effort: mostly landed`

- **The CISO security-audit remediation (#229, PARTIAL — most shipped).** The full vuln/pentest pass (`docs/audits/2026-11-04-ciso-security-audit.md`) shipped the trade-room relay guard, wallet-verification binding, input validation, `.npmrc` hardening, constant-time secret compares, Dependabot, WAF deny rules, 9 sensitive env secrets, MFA across every provider, and `main`-branch protection. **This week:** the two generic RATE-LIMIT rules were **decided DROPPED, not pending** (both abusive clients defeat a per-IP limit — the #235 entity sweep rotates regions, the Tencent crawler rotates IPs/UAs — and they are paid under "no infra spend pre-revenue"; the free custom rules cover the measured traffic instead). One more dead credential found — `GITHUB_ACTIONS_READ_TOKEN` (created 08-30) answers 401; the sentinel arm now reads the public repo anonymously (`dfd6c21c9`), so rotating it is optional. **Still Trevor's:** the secret-rotation TIERS in `docs/operations/secret-rotation-plan-2026-11.md`. Re-audit cadence quarterly, next 2027-02-04.
- **Security scans clean** (invariants, anon-write holes, rls-off-base-tables, secdef-anon all `[]`, per `rpc_ops_snapshot.security`, the 11-16 pass).
- **Live trust — user-facing clear, one dispositioned known-shape breach.** `topshot_impossible_parallel_serials` 0; `v_fmv_sanity_flags` **0**; `edition_integrity_flags` **8** (bar 250 — down from 20,627 last week). The 11-16 pass read **1 breach**: `candy_sales_stale_hours` 38.7 h (Candy market closed since 10-11, `breach_at` 0 indexer-unhealthy branch, no user impact; the drain is healthy — 1,752 resolved in 6 h). `trust_precompute_max_age_hours` 5.29 h ok, so the breach is a real read, not staleness.
- **Trade Room race conditions closed (#250, 11-14):** five row-locking SQL functions (`trade_room_{cancel,post_signature,mark_signing,unaccept,signing_ended}_locked`) close the signing races.
- **`#60` (carried):** Postgres cannot revoke `anon`/`authenticated` from the `net`/`cron` schemas; real fix needs Supabase support.
- **DB-invariant SQL layer: 314 `supabase/tests/*.sql` files** (+19, measured this run). CI is **21 jobs** in `ci.yml` (unchanged). **Never lower thresholds to green a build.**

### 2.5 Automation / asset hygiene — `Severity: Low–Medium · Effort: ongoing`

⚠ **`#235` — an unnamed external crawler degrades the whole site (OPEN, NEW 11-06).** A globally distributed fetcher sweeps a few hundred entity pages in under a minute, arriving through many edge regions at once (so a per-IP limit evades it). Mitigation is now fully IN: **both** a Vercel WAF rule `Entity page sweep` (keyed on JA4 digest, Challenge) **and** a custom Challenge on the Tencent Cloud ASN (`AS ∈ {132203, 45090}`, published 11-14 via Trevor's Chrome). The crawler has tapered (11-14: 731 challenged vs 230 allowed, vs 30–70k allowed per 6 h on 11-11/12). ⚠ Challenge will also challenge our own cloud QA sweeps — keep `RPC_QA_CONC` low and read a challenge page in a sweep as this rule, not an outage. **Exit:** a week with no minute > 400 invocations and Tencent `allow` ≈ 0. Read-only week-2 check scheduled **11-20 9:23 AM PT**.

⚠ **`#34` — Sentry dark; no-spend DECIDED** — the `window.onerror`/rejection beacon → `usage_events.client_error` is the detector; recent passes read ~1 benign event / 24 h. ⭐ **`#114` dashboards** stay ported to claude.ai artifacts (desktop-session work). The true-mobile QA instrument (`scripts/qa/mobile-sweep.mjs`, real Chromium at 390/320 px) remains the only real mobile instrument.

### 2.6 Overnight operational queue — `Severity: Low–High (mixed) · Effort: mixed`

Health scans GREEN on the 11-16 pass (0 stalled pipelines). Open items for Trevor / operator / Claude Code:

| Item | Issue | Severity | Notes |
|---|---|---|---|
| **#248 — wmc-fmv reconcile cost** | `reconcile_wmc_fmv_for_wallet` adds ≈ +1.3M reads/day; offset by job 617 going daily (net-negative IO). | **Med (close-out)** | Verified net-negative; the second writer fixed (`20261115204212`). Scheduled task runs the three exit checks **11-16 10:20 AM PT** and closes #248 if all pass (Trevor approved). |
| **#253 — `refresh_panini_sale_feed_status`** | pg_cron 714 (hourly :14) runs 45–110 s against its 120 s timeout and is killed ~once/day; wall time is random heap fetches over 4.79M unsold serials losing all-visible between vacuums. | **Med (Claude Code)** | pgss mean 16.6 s / max 117 s. Candidate: a cheaper counter source or a materialized count, not the index-only scan. |
| **#259 — Candy multi-mint re-key** | 90 → 63 editions merging different cards; fix shipped, census re-reads ~450 cards/run. | Med (watching) | Over-circ cards 3,857 → 2,400; ~1–2 days to drain. Close when re-measure SQL reads 0. |
| **#256 — Candy OpenSea capture** | 0 Candy OpenSea sales captured; on-chain capture from 08-31 planned. | Med (needs Trevor) | Needs `OPENSEA_API_KEY` (Vercel-only). |
| **#190 — Dune→DB lane** | Pre-2023 custodial pack opens addressable via Dune; worker lane not deployable. | Med (needs Trevor) | Set `CLOUDFLARE_API_TOKEN` repo secret, or add the query id in the Cloudflare dashboard. |
| **#229 — secret-rotation tiers** | MFA/WAF/branch-protection/Dependabot all done; the rotation TIERS are Trevor's. | Med (operator) | `docs/operations/secret-rotation-plan-2026-11.md`. Do before marketing. |
| **#58 OpenSea key** | 3 candy-opensea lanes unscheduled; only a Trevor-set key resumes the Candy book. | Low (optional) | Candy re-verify ~11-27. |
| **S1 / S3 / S6 + C2 + #22** | console token rotation (cron-job.org, GHA, Vercel) + CAN-SPAM postal address + the Dapper session rotation. | Med (operator) | Do before marketing; digests stay flag-off until C2 exists. |
| **DB-size baseline doc** | The June ~4.2 GB baseline reads as a ~13× regression against ~52–54 GB operating. | Low (housekeeping) | Reset it; keep the sawtooth + Panini walk on watch. |

### 2.7 Pack EV / pack-viz — `Severity: Low–Medium (correctness, mostly clean) · Effort: mostly landed`

Pack-EV surfaces label rows for packs nobody can buy and disclose AllDay/Golazos EV as an original-supply model; Candy leads with Typical-Pull median; the packs "Chase left" view shows sealed high-tier density vs launch. The #218 pack-index work (Dapper Studio sealed-pack index froze ~10-29; the Sniper now reads book freshness from on-chain secondary sales and marks a ≥ 2 h stale book as frozen) remains a partial — the upstream freeze is Dapper's. `pack_ev_history` had a one-off −691k-row thin on the 11-16 pass (1.41M → 723k; VACUUM retains the space for reuse), post-ship watch clean. The fresh-eyes pack-EV review this week found #249 (ISR failed-render caching) and #252 (sparse-wide read, since closed).

### 2.8 Chain foundation — Candy LIVE (frozen market, integrity cleared), Panini walked heavily, utility layer, live giveaways — `Severity: Low (shipped) · Effort: landed`

- **Candy / Solana — LIVE, THIN, market FROZEN since 10-11:** `CANDY_MLB_PUBLIC = true` (verified this run). The census integrity gate cleared this week (`edition_integrity_flags` 20,627 → 8, #246); the deep pass surfaced the #256–#259 edition-keying cluster, which is being worked down. `candy_sales_stale_hours` is the honest downstream symptom (re-verify ~11-27). Candy editions 21,568.
- **Panini — the WC Prizm + basketball plane** (`PANINI_PUBLIC = true`, verified this run). A heavy collector-walk week: editions **40,574 → 47,674 (+~7,100)**, the main durable DB-size driver. ⚠ #253 (`refresh_panini_sale_feed_status` timeout) is the cost tail of that growth.
- **Collector-utility layer:** the no-custody user-to-user Trade Room (signing live since 10-31, races now row-locked #250), the trade-in finder, follow-a-player, player checklists, and trophy challenges.
- **Giveaway instant delivery — LIVE and PROVEN (11-10).** Vault `0x38300125d58f76d1`, `RPC_GIVEAWAY_INSTANT_DELIVERY=1`; per-drop pack themes + opening sounds. The Dame Time reward drop delivered Moments to winners within seconds.
- **Rewards economy — exists but PAUSED (dial-in).**
- **Chain-abstraction Phases A–F complete.**

### 2.9 Read-only product pivot — carried, verified still in effect — `Severity: n/a (landed) · Effort: (done)`

Cart, Trade Hub, and Gifting remain **deleted from the tree** — verified this run by absence: `lib/cart`, `lib/trade-escrow`, `app/dashboard/trade-hub`, `app/dashboard/gift`, `lib/blazers-trivia.ts`, `docs/FREEZE.md` all absent. The product is read-only except for admin-signed giveaway delivery and the **no-custody user Trade Room** (`/trades`; signing live since 10-31, kill switch `RPC_TRADE_ROOM_EXECUTE`, races closed #250).

---

## 3. Known issues — by theme

Severity/effort are suggestions. "#" = the item number in `docs/reference/known-issues.md`. **§9 has the verified open/moved status.**

### Launch / activation (the whole critical path)

| # | Issue | Severity | Effort |
|---|---|---|---|
| — | **Traffic / WAU.** First real surge (35 signed-in, 20 signups, 27 challenge cases) but event-driven; ~11-19 re-read is the durability test. **No outreach** (10-14). | **High** | Medium (assets built, traffic event-driven) |
| — | **Go-live bars.** Accuracy gate: Top Shot MET (series, by-design ~45–46 % leg), All Day short AND slipping. Demand is the binding bar. | High | Mixed |

### Data completeness / accuracy / pricing

| # | Issue | Severity | Effort |
|---|---|---|---|
| 234 | FMV confidence labels are a 30-day sales COUNT, not measured accuracy; relabel RULE decided; earliest relabel after the Mon 11-23 accuracy read. | **Med–High (open)** | Measurement + relabel |
| 259 | 90 (→63) Candy multi-mint editions merge different cards; fix shipped + draining. | Med (open, draining) | Census re-key |
| 256 | Candy OpenSea sales not captured at all; on-chain capture from 08-31 planned. | Med (open, needs Trevor) | New indexer + `OPENSEA_API_KEY` |
| 257 | Legacy Candy asks feed the FMV cap; "sale but no FMV" coverage alert; watch `listings_retired`. | Low–Med (open, watching) | Instrument |
| 258 | Candy namesake collision (two "Luis Garcia"); future mislink risk. | Low (open, watching) | Team-aware name arm if it fires |
| 190 | Pre-2023 custodial pack opens — Dune can classify 201,255 unsourced moments; blocked on a Cloudflare worker secret. | Med (reopened) | Operator secret + Dune→DB lane |
| 228 | Cold-whale `/api/collection-snapshot` timeouts; index swap + 20 s wait + CDN stale window shipped (lever a); still occasional. | Low–Med (partial) | Stored-snapshot lever |
| 209 | Top Shot + All Day STALE cap; price + basis-line halves shipped; weekly reads still thin. | Low–Med (partial) | Mostly landed |
| 210 | Thin-sale haircut depth floor (0-sale cells 0.75); TS exit met; All Day cut + depth term open. | Low–Med (partial) | Measurement tail |
| 66 | Zero external links (gated on the accuracy gate); code items done; re-open at TS HIGH ≥ 75 % ×25 for two weeks. | Med | Off-platform (not code) |

### Plumbing / instruments / cost

| # | Issue | Severity | Effort |
|---|---|---|---|
| 248 | `reconcile_wmc_fmv_for_wallet` estate-wide IO cost; net-negative after job 617 daily; close-out scheduled 11-16 10:20 AM. | Low–Med (open, close-out) | Verification |
| 253 | `refresh_panini_sale_feed_status` killed ~once/day by random heap fetches over 4.79M unsold serials. | Med (open) | Cheaper counter source |
| 249 | ISR caches a failed pack-dist / entity-page render for its whole window (#33-class, per-page). | Low–Med (open) | Measure-first, segment-semantics fix |
| 218 | Dapper Studio pack index froze; Sniper reads book freshness from on-chain sales; upstream freeze is Dapper's. | Low–Med (partial) | Mostly landed |

### Security / operator

| # | Issue | Severity | Effort |
|---|---|---|---|
| 229 | CISO audit remediation mostly shipped; generic rate-limit rules dropped by decision; rotation TIERS Trevor's. | Med (partial) | Mostly landed + operator |
| 235 | Unnamed multi-region crawler; BOTH WAF rules live (JA4 + Tencent ASN, Challenge); week-2 read 11-20. | Med (open) | WAF watch |
| 60 | Cannot revoke anon/authenticated from net/cron schemas; needs Supabase support. | Low–Med | External |
| 34 | Sentry dark (beacon is detector; ~1 benign event / 24 h). | Med | Decided (no spend) |

### Tech debt / refactor

| # | Issue | Severity | Effort |
|---|---|---|---|
| 14 / 10 | Monolith page refactor — re-measured this run: DashboardClient **3,108**, SniperClient **2,362**, CollectionAnalyticsClient **2,043**, CollectionTabClient **1,907**, MarketClient **1,398**. | Low–Medium | Large |

### Stalled / scaffolded + deferred hardening

- Cart / Trade Hub / Gifting — **DELETED, verified still absent** (the Trade Room is a separate no-custody signed feature).
- Deferred hardening (intentional): `email_subscribers`/`outbound_clicks`/`portfolio_snapshots`/`support_conversations` public INSERT policies; `user_achievements`+`watchlist_items` still on `owner_key` (text); Golazos `highest_offer` gap SETTLED (no offer source — do NOT build the indexer); `sales-serial-backfill` substring-token check (latent dead code; `INGEST_SECRET_TOKEN` rotation owed); `buildTopshotPoolPayload` fabricated-divisor (latent, no live caller — exit when the pool lane revives, #65); `solUsdOn` historical-vs-spot basis (FIXED 11-03 — `solUsdOnWithBasis()`).

### Architecture notes worth tracking

- **Two "collection vocabulary" and two "confidence vocabulary" footguns** persist by design. Re-read `CLAUDE.md` before any new query. (Note the FMV-count keys use `panini_blockchain`, not `panini`.)
- **Flowty is fully retired (10-30)** — `flowty-proxy` is a 410 tombstone; All Day / Golazos / Pinnacle asks come from Dapper's own storefronts.
- **Supabase compute is `LARGE`** (resized from SMALL 2026-09-20). Any pre-09-20 finding citing the SMALL-tier disk-IO floor is stale — re-derive.
- **The June ~4.2 GB DB-size baseline doc is badly stale** — the DB now operates at ~52–54 GB on the pg_net sawtooth + the Panini walk; reset the baseline.
- **A metadata fix is not a page fix** — verify the rendered BODY, not the `<head>`. **A server→client prop must be data, never a callback; a `"use client"` module must never reach `lib/supabase.ts`; a query-param toggle cannot change what a crawler sees — one collection, one URL.** All green in `tsc`/vitest/lint but only a real render / live request says so; see `architecture-notes.md`.
- **Eight+ caller sources** — including a laptop collector-walk runner and cron-job.org — are invisible to a repo grep. Enumerate all before calling any ingest dead.

---

## 4. Prioritized next actions — **canonical**

`CLAUDE.md`'s old list is replaced by **`docs/strategy/roadmap-2026-10-17.md`** (canonical; accuracy-is-the-gate) and **`docs/strategy/go-live-2026-09.md`**:

| Phase | Action | Status |
|---|---|---|
| Gate | **Accuracy is the GATE — HIGH/MEDIUM share must beat incumbents, read as a series; now also measured against realised sales (`fmv_accuracy_weekly`).** | **Top Shot MET (series; ~45.6 % leg by design); All Day NOT MET (26.8 %) and SLIPPING; Pinnacle 32.7; Panini 45.7. First real accuracy read of the 11-04 fixes fills Mon 11-16; earliest relabel after Mon 11-23.** |
| Go-live | **M1–M11 bars.** | Latency/beacon/mobile bars met in prior cycles; accuracy gate met for Top Shot, short for All Day; demand is the binding bar. |
| 1 | **Prove the product with real users — 100+ WAU; no outreach (10-14).** | **Open — the critical path. Dame Time drove the first real surge (20 signups, 35 signed-in); the ~11-19 re-read tests whether they return. Convert the one-time traffic into retained WAU; hold outreach.** |
| 2 | Cost / latency / saturation levers. | **Watch — DB ~52–54 GB and climbing ~8 GB/wk (Panini walk + pg_net sawtooth), tier LARGE; reset the stale size baseline doc; #253 is the Panini cost tail.** |
| 3 | Durable debt. | Heavy advance — the pricing-accuracy relabel decision, the Candy census integrity fix + data-quality cleanup, the giveaway instant-delivery rail, the Trade Room race fixes. |
| 4 | Chain two, readiness-gated. | Candy LIVE (thin, market frozen; integrity cleared); Panini walked heavily; giveaways live; Rewards paused/dial-in. |

**Standing guardrails:** no paywall/Stripe until 100+ WAU; no infra spend pre-revenue; **no outreach** (10-14); **verify pages by rendered DOM, not HTTP 200**; **before gating/short-circuiting any route, enumerate EVERY caller** (eight+ sources).

**Housekeeping still outstanding:** land the #259 Candy re-key drain + the #256/#257/#258 Candy data-quality items; the #253 Panini counter cost cut; close out #248 (scheduled 11-16); finish the #229 secret-rotation tiers + S1/S3/S6 console tokens + C2 postal address + #22 Dapper session; the 11-20 #235 WAF week-2 read; set the #190 Cloudflare worker secret and the #256 OpenSea key; #58 OpenSea revisit (~11-27); convert the Dame Time cohort into returning WAU (activation); and reset the stale DB-size baseline doc.

---

## 5. In-code TODO inventory

A first-hand scan over tracked non-docs source (`git ls-files` → `*.{ts,tsx,js,jsx,mjs,cjs,sql,toml,css}`, excluding `docs/`; `node_modules`/`.next`/`.git` are untracked-excluded; **7,261** tracked non-docs source files) with `grep -nE '\b(TODO|FIXME|HACK|XXX)\b'` found **6 match lines, none actionable** — unchanged in character from prior weeks. (TODO 5 lines, XXX 2 — both on one format-literal line; FIXME 0, HACK 0.)

### 5a. Narrative / resolved-work references + the format-literal false positive (6 lines)

- `app/api/rtr/lock-roi/route.ts:38` — "v2 folds in the two signals the v1 TODO called out — TIER and SERIAL" (describes resolved work).
- `lib/chains/solana/normalize.ts:49` — "It was previously held as a TODO placeholder…" (resolved).
- `lib/format.ts:6` — the `"$X,XXX.XX" / "-$X,XXX.XX"` format doc comment; the `XXX` here is a format-string literal (twice), the exact false positive the task names.
- `lib/rtr-lock-roi-weights.ts:7` — "resolves the standing 'calibrate the absolute curve' TODO…" (resolved).
- `supabase/migrations/20260713050000_audit_20260713_wmc_team_name_denorm.sql:4` — "Motivation (was a TODO in components/collection/CollectionMomentTable.tsx):" (shipped; past-tense reference).
- `supabase/migrations/20260919173527_panini_bridge_candidates…sql:30` — "each is a pre-flip decision, **not a TODO**" (explicitly not a marker).

> **Net change since last week:** none of consequence. Live application code has **zero actionable** TODO/FIXME/HACK/XXX markers. `scripts/`, `workers/` (non-vendored) and `supabase/functions/` scanned clean. `TODO_`-prefixed launch-flag guard strings (which do not match `\bTODO\b`) persist by design.

---

## 6. Resolved / no action needed

Verified against the register STATUS INDEX, the 11-16 overnight metrics, and the demand/activity reviews:

**Newly resolved / landed / decided since last week (2026-11-09 → 2026-11-16):**
- **#208** — All Day + Golazos ASK_ONLY cap: RESOLVED 11-13 (exit still met; the two build items exist).
- **#241** — pg_net 4xx attribution blind to request_id-NULLing lanes: RESOLVED 11-13 (one `AFTER INSERT` trigger on `net.http_request_queue` now names the endpoint).
- **#242** — `backfill_pack_rip_metadata` ~19 s fixed cost: RESOLVED 11-10 (25/25 hourly runs ok, max 23 s, avg 10.9 s).
- **#243** — Panini profile picker latency: RESOLVED 11-10 (6,023-card profile answers in 4.4 s cold / 0.16 s warm).
- **#244** — linked-walk collection list: RESOLVED 11-09 (24/24 collections on the 7:20 PM linked walk).
- **#245** — refused-continuation resume: RESOLVED 11-10 (works end-to-end in production, second defect exposed + fixed).
- **#246** — Candy census integrity gate: RESOLVED 11-12 (`edition_integrity_flags` 2,660 → 187 → 34 → 8; census fills/retires/re-points).
- **#247** — one key per Candy card + emptied alias editions removed: RESOLVED 11-13.
- **#250** — Trade Room signing races: RESOLVED 11-14 (five row-locking SQL functions).
- **#251** — Top Shot parallel sales filed on the base edition: CLOSED 11-14 (write-time trigger + v2 + 6-hourly follow-up).
- **#252** — sparse-wide snapshot read: CLOSED 11-14 (reads only the top-W editions by latest sale; no precompute).
- **#254** — what a public profile may publish about a collector's wallets/history: CLOSED (decided + shipped) 11-14.
- **#255** — "Total Mint" + first/last labels: CLOSED 11-15 (parked copy dropped `20261115183513`).

**Note on churn:** the register grew 240 → 257 numbered items in one week (+17), closed +12 (229 → 241), and open+partial rose 11 → 16. Most of the new slots shipped-and-closed in the same window (the Candy census cleanup, the pricing-tail work, the Trade Room fixes). The open rise is concentrated in the **Candy data-quality cluster** (#256–#259), surfaced by the same deep census pass that cleared the 20,627-flag integrity gate — a discovery-and-fix surge, not a backlog of latent defects. **#190 reopened** because a capability (the Dune connector) was acquired, not because anything regressed.

---

## 7. Suggested sequence

A pragmatic order under **accuracy-is-the-gate** + the go-live bars (outreach off, gate 100+ WAU):

1. **Convert the Dame Time cohort into returning WAU (the activation lever).** The ~11-19 weekly re-read is the honest test of whether the 20 signups return; whatever retains them (concierge nudges, "here's your squeeze / EV / what to chase," a second reason to come back) is now the highest-leverage product work, because for the first time there is a real cohort to retain. Get a clean internal-excluded WAU read; hold outreach until the 100-WAU gate opens.
2. **Drain the Candy data-quality cluster:** let #259's re-key finish (editions → 0 over-circ, ~1–2 days), settle #257's `listings_retired` watch, keep #258's namesake watch empty, and decide #256 (the on-chain OpenSea capture, which needs the OpenSea key).
3. **Relabel FMV confidence by measured accuracy (#234).** After the Mon 11-23 `fmv_accuracy_weekly` run (the first with two agreeing post-11-04 weeks), make each label's promise match its segment's within-±25 %. This is the "pricing is the anchor" work and it directly addresses the All Day slip. Keep labels INTERNAL.
4. **Cut the #253 Panini counter cost** (a cheaper source than the full index-only scan over 4.79M serials) and **close out #248** (the scheduled 11-16 10:20 AM verification).
5. **Watch the dated proofs:** the #234 accuracy fill (Mon 11-16) and relabel window (after Mon 11-23), the weekly demand re-read (~11-19, the durability test), the #235 WAF week-2 read (11-20), Candy market re-verify (~11-27).
6. **Finish the CISO tail (#229):** the secret-rotation tiers + S1/S3/S6 console tokens + C2 postal address + #22 Dapper session (operator/Trevor) — before any marketing.
7. **Set the operator secrets that unblock capability:** #190's `CLOUDFLARE_API_TOKEN` (the Dune→DB lane) and #256's `OPENSEA_API_KEY`.
8. **Reset the stale DB-size baseline doc** (~4.2 GB June → operating ~52–54 GB) and keep the `net._http_response` sawtooth + the Panini walk on watch.

---

## 8. Notes from verification

- **Sandbox / device shell active this run.** `git`/`grep`/`wc`/`ls` all work over the connected repo; counts are first-hand. **1,032 commits** since 2026-11-09 (`git log --since`); mount HEAD `4029d240b` 2026-11-16 09:14 (rpc-overnight). Authors: Claude 896, Trevor 72, Claude (Cowork) 22 (+1 QA), rpc-daytime-monitor 21, overnight/migration bots ~20. The mount is level with `origin/main` (both `4029d240b`).
- **Counts measured this run:** CI = **21** jobs under `jobs:` in `.github/workflows/ci.yml` (unchanged). DB-invariant test files = **314** (`supabase/tests/*.sql`, `ls`, +19); `app/insights/*/page.tsx` = **39** (unchanged). Monoliths re-measured (`wc -l`): DashboardClient 3,108 / SniperClient 2,362 / CollectionAnalyticsClient 2,043 / CollectionTabClient 1,907 / MarketClient 1,398.
- **Live metrics (from the 2026-11-16 ~1:11 AM PT overnight pass):** DB size **53,881 MB** (~53.9 GB; up from 45,643 last week and 52,838 at the prior overnight read — the pg_net sawtooth + a heavy Panini walk; operating band now ~52–54 GB). Trust: **1 known-shape dispositioned breach** — `candy_sales_stale_hours` 38.7 h (Candy market closed); `v_fmv_sanity_flags` 0; `topshot_impossible_parallel_serials` 0; `edition_integrity_flags` **8** (bar 250; was 20,627). FMV HIGH+MED by collection: Panini 20,428, NBA 7,026, NFL 1,784, Pinnacle 991, Candy 2, Golazos 1, UFC 0. Editions: Panini **47,674** (+~7,100 wk), Candy 21,568, NBA 14,975, NFL 6,190, Golazos 575, UFC 625. Client-error beacon ~1 benign event / 24 h. Vercel 24 h: 4 chronic graceful-degradation runtime-error groups, none new, no crash class; prod `a1378127b` READY. Security clean (all four arms).
- **Accuracy — file-blessed series (roadmap-status 11-07 block, wk 11-02 partial):** Top Shot 45.6, All Day 26.8, Pinnacle 32.7, Candy 48.1 (now drained — live FMV HIGH+MED 2), Panini 45.7, Golazos 0.2, UFC 0.0. ⚠ This is the latest file-blessed read and is **9 days old** — the headline legs were not re-read this week (no FMV route change shipped; the 11-16 pass notes "FMV HIGH+MED stable"). **Read a series, not a leg.** The `fmv_accuracy_weekly` instrument (#234) first reads the 11-04 fixes in the 11-09 week (fills Mon 11-16); earliest relabel after the Mon 11-23 run.
- **Demand (weekly, 11-05..11-11, read 11-13):** 252 browsers / 538 visits (580 crawler-burst excluded), 35 external signed-in (↑ from 5), 20 signups (↑ from 1), 27 challenge cases (all complete), X 5 → 86 visits, 121 wallet pastes (22 browsers), search flat (Google 20 → 12). Off-cycle review (11-03..11-09): 9 of 19 early signups returned on a second day. Next weekly re-read ~11-19 (durability test).
- **TODO scan: 6 match lines, 0 actionable** (§5) — tracked non-docs source via `git ls-files` + `grep -nE '\b(TODO|FIXME|HACK|XXX)\b'`; the two `XXX` hits are the `$X,XXX.XX` format literal on one line; the other 5 are past-tense/resolved TODO references.
- **Deletions verified by absence (`test -e`):** `lib/cart`, `lib/trade-escrow`, `app/dashboard/trade-hub`, `app/dashboard/gift`, `lib/blazers-trivia.ts`, `docs/FREEZE.md` — all absent.
- **Launch flags verified:** `lib/launch-flags.ts` `CANDY_MLB_PUBLIC = true`, `PANINI_PUBLIC = true`; Trade Room kill switch `RPC_TRADE_ROOM_EXECUTE` present (`lib/trade-room/execute.ts`).
- **Cited paths spot-checked — one stale reference persists (same as last week).** Resolve (no issue): `docs/strategy/roadmap-2026-10-17.md`, `docs/strategy/go-live-2026-09.md`, `docs/reference/{known-issues,roadmap-status,architecture-notes,tooling-gotchas}.md`, `docs/audits/2026-11-04-ciso-security-audit.md`, `docs/operations/{secret-rotation-plan-2026-11,flowty-retirement-runbook}.md`, `docs/strategy/{features/pack-ev,seo-2026-09-06-search-console-read}.md`, the eight `docs/handoff-2026-11-04-*.md` files, `scripts/{qa/mobile-sweep.mjs,demand-read.sql}`, `lib/{sniper/header-copy,packs/pack-deals,db/omit-unread,offers/edition-offer-rows,chains/solana/opensea,giveaways/vault-cadence,giveaways/wallet-cache,launch-flags,trade-room/execute}.ts`, `app/api/golazos-offers-indexer/route.ts`. ⚠ **Stale:** `docs/proposals/wmc-snapshot-cover-index-swap-STAGED.sql` is still cited in **open item #228** but is **ABSENT** — the index swap it staged was completed via the dashboard on 11-04, so the reference should be marked done in the item. (This was flagged in the 11-09 report and has not yet been updated.)
- **Known-issues STATUS INDEX:** its own generated line reads **257 numbered items — 10 open · 6 partial · 241 closed**; the 10 open are **#190, #234, #235, #248, #249, #253, #256, #257, #258, #259**; the 6 partial are **#66, #209, #210, #218, #228, #229**; the newest filed slot is **#259**.
- This report did **not** edit `CLAUDE.md` or any source file and did **not** touch git — it only created this file.

---

## 9. Known-issues reconciliation (verified 2026-11-16)

The register's own generated STATUS INDEX reports **257 numbered items — 10 open · 6 partial · 241 closed**. ⛔ `closed`/`open` means the item *says* so — read its own date stamp. The current open/partial set and the items that moved since last week:

| # | Issue | Index status | Verified status | Evidence |
|---|---|---|---|---|
| 190 | Pre-2023 custodial pack opens | 🟡 **open** | REOPENED 11-14 — Dune connector bought; 201,255 unsourced moments classifiable; blocked on the `CLOUDFLARE_API_TOKEN` worker secret | known-issues #190 |
| 234 | FMV confidence labels are a 30-d sales count, not measured accuracy | 🟡 **open** | Relabel RULE decided 11-13; earliest relabel after the Mon 11-23 `fmv_accuracy_weekly` run | known-issues #234 |
| 235 | Unnamed multi-region crawler degrades the site | 🟡 **open** | BOTH WAF rules live (JA4 + Tencent ASN, Challenge); crawler tapered; week-2 read 11-20 | known-issues #235 |
| 248 | `reconcile_wmc_fmv_for_wallet` estate-wide IO cost | 🟡 **open** | Net-negative verified; second writer fixed; close-out scheduled 11-16 10:20 AM PT | known-issues #248 |
| 249 | ISR caches a failed pack-dist / entity-page render | 🟡 **open** | NEW 11-14 — #33-class, per-page; measure-first then a segment-semantics fix | known-issues #249 |
| 253 | `refresh_panini_sale_feed_status` killed ~once/day | 🟡 **open** | NEW 11-14 — random heap fetches over 4.79M unsold serials; needs a cheaper counter | known-issues #253 |
| 256 | Candy OpenSea sales not captured at all | 🟡 **open** | NEW 11-14 — on-chain capture from 08-31 planned; needs `OPENSEA_API_KEY` | known-issues #256 |
| 257 | Legacy Candy asks feed the FMV cap; coverage alert | 🟡 **open** | NEW 11-14 — legacy-listings lane live; watch `listings_retired` | known-issues #257 |
| 258 | Candy namesake collision (two "Luis Garcia") | 🟡 **open** | NEW 11-15 — today's 12 editions correct; future-mislink watch must stay empty | known-issues #258 |
| 259 | Candy MULTI-mint editions merge different cards | 🟡 **open** | NEW 11-15 — fix shipped 11-15; editions 90 → 63, over-circ 3,857 → 2,400, draining | known-issues #259 |
| 66 | SEO / zero external links | 🟠 partial | Code done; external links gated; re-open at TS HIGH ≥ 75 % ×25 for two weeks | known-issues #66 |
| 209 | Top Shot + All Day STALE cap | 🟠 partial | Price + basis-line halves shipped; weekly reads still thin | known-issues #209 |
| 210 | Thin-sale haircut depth floor | 🟠 partial | TS exit met; All Day cut + depth term open (no listing history to backtest) | known-issues #210 |
| 218 | Dapper Studio pack index froze | 🟠 partial | Sniper reads book freshness from on-chain sales; upstream freeze is Dapper's | known-issues #218 |
| 228 | Cold-whale `/api/collection-snapshot` timeouts | 🟠 partial | Lever (a) shipped (covering index + STALE read); stored-snapshot lever still open; ⚠ cites a now-absent STAGED.sql | known-issues #228 |
| 229 | 2026-11-04 CISO security audit | 🟠 partial | Remediation mostly shipped; generic rate-limit rules dropped by decision; rotation tiers Trevor's | known-issues #229 |
| 208 | All Day + Golazos ASK_ONLY cap | ✅ closed | RESOLVED 11-13 (was partial last week) | STATUS INDEX |
| 241 | pg_net 4xx attribution | ✅ closed | RESOLVED 11-13 (was open last week) | STATUS INDEX |
| 242 | `backfill_pack_rip_metadata` fixed cost | ✅ closed | RESOLVED 11-10 (was open last week) | STATUS INDEX |
| 243–247, 250–255 | Panini picker / linked walk / resume / census integrity / key-per-card / Trade Room races / parallel base-edition / sparse-wide / profile publish / Total-Mint labels | ✅ closed | all resolved/decided in-window | STATUS INDEX |

**Tally (per the register's own STATUS INDEX):** **257 numbered items — 10 open · 6 partial · 241 closed**, newest slot **#259**. Plus the go-live plan, the per-collection accuracy legs, Candy live (market frozen, integrity cleared) + Panini walked heavily + the collector-utility layer + trophy challenges + live giveaway instant delivery + Rewards paused, **21-job CI**, **314 DB-invariant test files**, and **39 public `/insights` surfaces**.

**Bottom line for `CLAUDE.md`:** another very heavy, clean week (1,032 commits), all interactive Cowork / Claude Code, with the autonomous pass green-and-idle every night. The week's headline is the first real demand signal in the project's history — **the Dame Time challenge + proven-live giveaway instant delivery drove signups 1 → 20 and signed-in users 5 → 35**, with the challenge board the top sign-in surface. The pricing-accuracy arc advanced to a **decided relabel rule** (earliest relabel after the Mon 11-23 accuracy read), and a deep **Candy census pass cleared the 20,627-flag integrity gate** (#246) while surfacing a concentrated Candy edition-keying cluster (#256–#259, the multi-mint re-key already draining). Open+partial rose **11 → 16**, with three of last week's items closed (**#208**, **#241**, **#242**) and **#190 reopened** on the new Dune capability. Live user-facing trust is clean (0 impossible serials, 0 FMV sanity flags, integrity flags back to 8); the one standing breach is the known-shape Candy closure. On the front page, **Top Shot is MET on its series (~45.6 % leg by design), All Day is short AND slipping (26.8 %, -0.3/wk)**, **DB is ~53.9 GB and up ~8 GB/wk** on the heavy Panini walk + the pg_net sawtooth, and **demand is still the one number that decides everything** — this week it finally moved, but on a one-time event, so the **~11-19 re-read (do the 20 signups return?) is the single most important line in next week's report.** The standing asks are operator/Trevor: the **#229** rotation tiers (+ S1/S3/S6, C2, #22), the **#190/#256** capability secrets (`CLOUDFLARE_API_TOKEN`, `OPENSEA_API_KEY`), the 11-20 **#235** WAF week-2 read, and converting the Dame Time cohort into returning authed users.
