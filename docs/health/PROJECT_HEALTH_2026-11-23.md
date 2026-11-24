# Rip Packs City — Project Health Report

**Date:** 2026-11-23
**Compiled by:** Claude (Cowork) — automated weekly run
**Sources:** `CLAUDE.md` + `docs/reference/known-issues.md` (generated STATUS INDEX, now reading **259 numbered items — 6 open · 6 partial · 247 closed**, newest slot **#261**), the canonical forward plan `docs/strategy/roadmap-2026-10-17.md`, `docs/reference/roadmap-status.md` (the 11-07 headline-metric block, the 11-12 price-accuracy block, the 11-13 demand read of PT week 11-05..11-11, the **11-20 activity+concierge review of the rolling week 11-13..11-20**, the 11-17 activity review, and the **11-22 strategy-read "Decisions taken"** block + the "Open items" / "Needs Trevor" ledgers), `docs/reference/architecture-notes.md`, `docs/overnight/metrics-latest.json` (the 2026-11-23 ~1:10 AM PT overnight pass) plus the 2026-11-23 ~9:12 AM PT mount HEAD for the most recent live read, and first-hand file-tool + shell scans over the connected repo (`git`, `grep`, `wc`, `ls`) at ~03:10 AM PT.
**Scope:** A single consolidated, themed view of open work — the numbered known-issue slots (`#0–#261`), the go-live framing, the prioritized actions, the overnight operational queue, and the in-code marker inventory — with suggested severity, effort, and a recommended sequence.
**Prior report:** `PROJECT_HEALTH_2026-11-16.md` (7 days ago). This regeneration mirrors its structure. `_2026-11-09.md` … `_2026-05-22.md` (twenty-eight earlier reports) also live in `docs/health/`.

> **Biggest change since 2026-11-16 — the ~11-19 durability test came back NEGATIVE: the Dame Time surge did not retain, and the response was a Top Shot gate redefinition plus a wave of activation plumbing.** The week shipped **830 commits since 11-16** (down from last week's 1,032 but still a heavy week), again almost all interactive Cowork / Claude Code — the autonomous pass stayed green-and-idle every night (the 11-23 pass shipped 0, reverted 0). The dominant workstreams were (1) **the demand durability read** — last week's single most important line was "do the 20 Dame Time signups return?", and the 11-20 rolling read (11-13..11-20, the first full week after the 11-10 challenge lock) answered it: **signups fell 21 → 3, external signed-in users 36 → 20, human browsers 267 → 197, and concierge human use went to 0** — events spike but do not durably retain, though external signed-in users held at 20 (vs the pre-Dame floor of 5). The team responded by shipping an **activation plumbing layer** (the Day-1 wallet email live 11-18, a weekly email to 53 eligible members first firing Mon 11-23, a per-member player deal-alert line, an "Is this your collection?" binder save card, a no-account edition look-up); (2) **a Top Shot gate redefinition (11-22 strategy read)** — the gate moved from the HIGH/MEDIUM-share series to **realised-sales accuracy** (HIGH and MEDIUM each ≥ 70 % within ±25 % for four consecutive weekly reads, a drop-day ≥ 70 %, plus M3–M11), **All Day's M2 no longer holds Top Shot**, and a proposed "maintenance mode" for the smaller collections was reversed the same morning ("users won't come to halfway-built features"); (3) **the Candy data-quality cluster was largely drained** — #259 (multi-mint re-key), #257 (legacy asks) and **#256 (on-chain capture)** all closed, the last after a falsifier found **68 uncaptured Candy fills on the 7Aru / Tensor venues = ~44 % of the week's Candy dollars**, now captured; and (4) **a new physical-cards / Panini-paper prototype** (off by default) plus a continued heavy Panini walk (editions **47,674 → 55,857**). The register grew **+2 slots (#260–#261)** and **closed +6 (241 → 247)**; open+partial moved **16 → 12**. Five of last week's open items closed (**#248, #253, #256, #257, #259**); **#261 opened** (acquisition-date fill, blocked on Dune credits until ~12-13). The current open set is the FMV relabel (#234), the Tencent crawler (#235, recurred), one ISR-cache item (#249), the Candy namesake watch (#258), the pre-2023 pack-open lane (#190), and the new acquisition-date item (#261), plus six partials — one of which (**#218**) **worsened**.

> **Overnight reality — GREEN and idle by design, again, every night this week.** The 2026-11-23 ~1:10 AM PT pass (Cowork cloud, push-capable via the laptop-VM `.rpc-git-cred` route, no `FREEZE`) **shipped nothing** and logged a quiet, healthy night: the two outstanding daytime-monitor queue items both need access the night pass lacks (a `wallet_held_pack_value` timeout = off-limits route-logic change; a stale `ingest-topshot-challenges` suppression delete = attended SQL editor). Security scans clean on all four arms; **0 trust breaches, no UNKNOWN rows** (last week carried 1 dispositioned breach; `candy_sales_stale` now reads 6.3 h / ok). The week's shipping was all interactive Cowork / Claude Code sessions.

> **Traction reality — the Dame Time surge did NOT retain; the activation layer is the bet, and its first real read is ~11-24.** The rolling-7-day read (11-13..11-20, `scripts/demand-read.sql`, read 11-20) shows **197 human browsers / 285 visits** (267/572 the week before, 1,909 crawler-burst visits excluded), **78 engaged browsers** (from 134), **20 external signed-in users** (down from 36 but up from the pre-Dame 5), **3 signups** (down from 21; 2 saved a wallet), and **0 concierge human messages** (from 19 — the instrument is proven live, the zero is real). The 11-17 review found the Dame Time cohort (19 accounts) left 13 active in the week and **0 of 5 new signups returned on a second day**. The team's read: the event spiked both acquisition and activation but did not retain, so the week's product work turned to **activation plumbing** — the Day-1 wallet email (live 11-18, 2 sent + delivered), a weekly email to **53 eligible members** (first firing Mon 11-23, carrying a per-member player deal-alert line), an "Is this your collection?" binder save card, and a no-account edition look-up. ⚠ The user gate is **100 WAU**; outreach is still off by directive (10-14). The honest test is the **next read on/after Tue 11-24** — the first measurement of whether the activation emails convert. **The next challenge is deferred** (Trevor, 11-20: "we'll do a challenge later").

> **Accuracy gate — REDEFINED this week, and the second number (realised-sales accuracy) is climbing.** The **11-22 strategy read** moved the Top Shot gate off the HIGH/MEDIUM-share series onto **realised-sales accuracy**: HIGH and MEDIUM each ≥ 70 % within ±25 % for four consecutive weekly reads, plus one drop-day ≥ 70 % at sale, plus M3–M11 — and **All Day's M2 no longer gates Top Shot** (1 of 4 weeks met at decision). On that new instrument (`fmv_accuracy_weekly`, within ±25 %), the first post-11-04 week (11-09) read **Top Shot ALL 70.3 · HIGH 80.1 · MEDIUM 74.1 · LOW 57.0** (baseline wk 10-26: ALL 68.2 · HIGH 74.3 · MEDIUM 69.1 · LOW 54.9) — HIGH and MEDIUM both cleared 70 % for the first time (the ASK_ONLY cell's collapse to 18.4 is an instrument artifact from the 11-11 drop, not a regression; established editions read 60.9). All Day 11-09: ALL 62.8 · HIGH 76.8. The older HIGH/MEDIUM-share **weekly-mean legs** (`rpc_trust_health_history`, 11-07 block, **now 16 days old**; no FMV route change re-measured them this week) still read: **Top Shot 45.6 %**, **All Day 26.8 %** (⬇ -0.3/wk), Pinnacle 32.7 %, Candy 48.1 % (drained — live FMV HIGH+MED now **33** after the on-chain capture reopened Candy sales), Panini 45.7 %, Golazos 0.2 %, UFC 0.0 % (closed-market sentinel). The **relabel (#234)** waits on the Mon 11-23 `fmv_accuracy_weekly` run (two agreeing post-11-04 weeks).

> **Cost / storage — ~56.8 GB, up ~3 GB on the continued Panini walk.** Live read: DB **56,823 MB (~56.8 GB)** at the 11-23 1:10 AM pass (up from 53,881 MB last week; +1,093 MB vs the prior overnight read, routine growth). The operating band has stepped up to **~55–57 GB**. Durable growth is still Panini: editions **47,674 → 55,857 (+~8,183 week-over-week — another very heavy collector-walk week)**, `panini_card_serials` remains the main DB-size driver. Compute stays **LARGE** (resized 09-20). ⚠ The ~4.2 GB June DB-size baseline doc remains **badly stale** — the real operating baseline is now ~55–57 GB; resetting it so it stops reading as a ~13× regression is still an open housekeeping item.

> **Platform context.** Top Shot's public REST API stays dead; the Atlas backend is the feed and answers a Cloudflare 403/404 on some lanes by design (self-healing; the chronic Atlas/Dapper lanes account for the 8 info-level pipeline alerts on the 11-23 pass, all designed outcomes). **Flowty stays RETIRED (10-30)**. ⚠ **`#218` WORSENED this week — Dapper Studio GraphQL now answers HTTP 530 to *every* request, also from a residential box** — breaking the TS/AD/Golazos pack-sales walkers, Golazos/Pinnacle pack opens, and AD/Golazos pack EV; pack asks and chain pack sales still move via Atlas. **Candy/Solana is LIVE** — its Magic Eden book has been frozen since 2026-10-11, but the **on-chain 7Aru / Tensor capture (#256) reopened real Candy sales** (68 fills found, ~44 % of the week's dollars; now captured hourly), lifting live FMV HIGH+MED from 2 → 33. **UFC Strike moved to Aptos on 2026-11-15; the Flow side is closed** (0 Flow sales; honestly labelled). NFL All Day secondary-market only. Panini = WC Prizm + basketball plane (`PANINI_PUBLIC = true`); the collector-walk runs on Trevor's laptop. **Giveaway instant delivery is LIVE and proven** (vault `0x38300125d58f76d1`). **Dune connector (#190/#261)** remains blocked: #190 on a Cloudflare worker secret, #261 on Dune credits until ~12-13.

> This is a snapshot. `CLAUDE.md` + `docs/reference/known-issues.md` are the source of truth for project memory; `docs/overnight/` for what shipped; `docs/strategy/roadmap-2026-10-17.md` for the plan. This doc reorganizes them for triage. **Severity and effort tags throughout are suggestions, not gospel.**

> **Report location stays clean.** All reports (this one included) live in `docs/health/`; the repo root holds none (verified this run).

---

## 1. At a glance

| Bucket | Count | Notes |
|---|---|---|
| Known-issue slots tracked | **#0–#261** | Register STATUS INDEX: **259 numbered items — 6 open · 6 partial · 247 closed**. 2 new slots (#260–#261) since last week. See §9. |
| Known issues — resolved/closed since last week | **+6 net** | Closed count rose 241 → 247. Moved off the open/partial list: #248, #253, #256, #257, #259 (closed) — plus the new #260 that shipped-and-closed in-window. See §6 / §9. |
| Known issues — open / partial | **12** | **6 open** (#190, #234, #235, #249, #258, #261) + **6 partial** (#66, #209, #210, #218, #228, #229). Down from 16 last week. — §3 / §9 |
| Known issues — 🚨 live trust breach | **0** | On the 11-23 pass: **0 breaches, no UNKNOWN rows** (last week: 1 dispositioned). `candy_sales_stale` 6.3 h / ok; `topshot_impossible_parallel_serials` 0; `v_fmv_sanity_flags` 0; `edition_integrity_flags` **8** (bar 250). — §2.4 |
| Known issues — needs Trevor, operator | **few** | **#229** secret-rotation tiers (MFA/WAF/branch-protection/Dependabot all done); **#190** Cloudflare worker secret for the Dune lane; **#261** Dune credits (~12-13); **#58** OpenSea key (optional, ~11-27); **#66** external links (gated); C2 postal address; S1/S3/S6 console token rotation; #22 Dapper session rotation. — §2.6 |
| Known issues — carried shelved | **~1** | **#58** OpenSea key — the Candy book is now fed on-chain (#256), so the ME key is optional; re-verify ~11-27. |
| Known issues — removed from the tree by decision | 3 | #1 Cart, #3 Trade Hub, #3b Gifting — DELETED (read-only pivot). Verified still absent this run. |
| Go-live plan | **M1–M11 + B1–B5** | `docs/strategy/go-live-2026-09.md`. **Gate redefined 11-22:** Top Shot = realised-sales accuracy (HIGH+MED each ≥ 70 % ×25 for 4 weeks + a drop-day); All Day M2 no longer gates. Demand is the binding bar. — §2.1 |
| Commits since last report | **830** | `git log --since 2026-11-16` on the connected mount. Authors: Claude 723, Trevor 72, rpc-daytime-monitor 14, rpc-overnight 6, rpc-migration-autorecover 5, Cowork nightly 2, surface-QA 2, overnight 2, night-pass 2, others 2. Mount HEAD `a46e706c6` 2026-11-23 09:12 PT (RPC night pass); mount is level with origin. |
| Accuracy — the HIGH/MEDIUM-share legs | **Per-collection weekly-mean legs (11-07 read, 16 d old)** | Top Shot **45.6 %**, All Day **26.8 %** (slipping), Pinnacle 32.7, Candy 48.1 → drained (live FMV HIGH+MED 33), Panini 45.7, Golazos 0.2, UFC 0.0 (sentinel). Not re-measured this week (no FMV route change). — §2.1/§2.3 |
| Accuracy — the realised-sales number (now the gate) | **`fmv_accuracy_weekly`, wk 11-09 within ±25 %** | **Top Shot ALL 70.3 / HIGH 80.1 / MED 74.1 / LOW 57.0** (both HIGH+MED cleared 70 % first time), All Day ALL 62.8 / HIGH 76.8. Gate = 4 consecutive weeks; 1 met. Relabel earliest after Mon 11-23. — §2.3 |
| Demand (the critical-path number) | **surge did NOT retain** | Rolling 11-13..11-20: **197 browsers / 285 visits, 20 signed-in (↓ from 36), 3 signups (↓ from 21), 0 concierge human msgs.** Gate **100+ WAU**; **no outreach** (10-14). Activation layer shipped; next read ~11-24. — §2.1 |
| Open overnight operational items | **standing queue** | #190 Dune→DB lane (worker secret); #261 Dune credits (~12-13); #58 OpenSea (optional); #229 rotation tiers; DB-size baseline reset. #248/#253 both CLOSED this week. — §2.6 |
| Net-new structural workstream | 2 live + utility + giveaways + **physical-cards proto** | Candy/Solana LIVE (on-chain capture reopened sales) + Panini (heavy walk, 55,857 editions) + the collector-utility layer + live giveaways; **new: a physical-cards / Panini-paper-crosswalk prototype, off by default**. — §2.8 |
| Prioritized next actions | **canonical** | `roadmap-2026-10-17.md` (accuracy-is-the-gate) + `go-live-2026-09.md` + the 11-22 gate redefinition. Gate: **100+ WAU**, no outreach, no infra spend pre-revenue. See §4. |
| In-code TODO markers | **0 actionable** | Measured this run (`git ls-files` + `grep` over **7,553** tracked non-docs source files): **6** match lines, all narrative/false-positive (incl. the `$X,XXX.XX` literal). — §5 |
| Test / DB-invariant pins | **317 `supabase/tests/*.sql` files** | +3 vs last week's 314 (measured this run, `ls`). |
| CI jobs (ci.yml) | **21** | Measured this run under `jobs:` — unchanged from last week (same 21). See §8. |
| Public `/insights` surfaces | **39** | Measured this run: 39 `app/insights/*/page.tsx` surface dirs (unchanged; 40 `page.tsx` incl. the index). |
| Active revenue-blocking items | 0 | By decision — monetization tabled until 100+ WAU. |

**Health read:** Another heavy, clean shipping week — 830 commits, almost all interactive, the autonomous pass green-and-idle every night. The headline is that last week's open question got an honest, slightly deflating answer: **the Dame Time demand surge did not durably retain** (signups 21 → 3, signed-in 36 → 20), so events spike but do not hold on their own. The constructive response was twofold — a layer of **activation plumbing** (Day-1 and weekly emails, player deal-alerts, a binder save card, a no-account look-up) whose first real read is ~11-24, and a **gate redefinition** that moves Top Shot off the share-series and onto realised-sales accuracy, where the number is genuinely improving (HIGH 80.1, MEDIUM 74.1 both cleared 70 % on the 11-09 week). The register's open work *shrank* (16 → 12): the concentrated Candy data-quality cluster largely drained (#256/#257/#259 closed), including an on-chain capture fix that recovered ~44 % of the week's Candy sales dollars. The concentrated risks: **(1) retention/activation** — the honest test is whether the new email layer converts (~11-24), against a 100-WAU gate with outreach off; **(2) the Dapper Studio 530 (#218 worsened)** — a now-total upstream outage breaking several pack walkers and pack-EV surfaces (upstream, not ours); and **(3)** DB growth — ~56.8 GB and climbing on the Panini walk. Live user-facing trust is clean (0 breaches, 0 impossible serials, 0 FMV sanity flags).

### Themes

| Theme | Items |
|---|---|
| **Launch / activation (the whole critical path)** | Public + self-serve. **Dame Time surge did NOT retain** (signups 21 → 3, signed-in 36 → 20); an **activation email layer** (Day-1, weekly, player deal-alerts, binder save card) shipped — first read ~11-24. Gate **100+ WAU**, **outreach off** (10-14). (§2.1) |
| **Top Shot gate redefinition (the week's strategy arc)** | 11-22: gate = realised-sales accuracy (HIGH+MED each ≥ 70 % ×25 for 4 consecutive weeks + a drop-day ≥ 70 % + M3–M11); **All Day M2 no longer gates Top Shot**; "maintenance mode" proposed then reversed (every collection keeps being built; lane budget 318 pg_cron jobs). (§2.1/§4) |
| **Pricing accuracy — "the anchor of everything"** | `fmv_accuracy_weekly` wk 11-09: TS HIGH 80.1 / MED 74.1 (both cleared 70 % first time). #234 relabel earliest after the Mon 11-23 run; the 11-12 thin-tail / bid-pull work is reflected here. (§2.3) |
| **Candy data-quality cluster — largely DRAINED** | #259 multi-mint re-key RESOLVED 11-17; #257 legacy asks RESOLVED 11-21; **#256 on-chain capture RESOLVED 11-22** (68 uncaptured 7Aru/Tensor fills = ~44 % of Candy dollars, now captured; live HIGH+MED 2 → 33). #258 namesake watch stays open but empty. (§2.3) |
| **Dapper Studio upstream outage (#218 WORSENED)** | GraphQL now 530 to every request, from everywhere — breaks TS/AD/Golazos pack-sales walkers, Golazos/Pinnacle pack opens, AD/Golazos pack EV. Pack asks + chain pack sales still move via Atlas. Upstream, not ours. (§2.7) |
| **External crawler sweep (#235) — RECURRED** | The multi-region sweeper came back 11-16 (~06:10Z) through **17 edge regions** at ~500/min; the per-minute half of the done-check FAILS, so #235 STAYS OPEN. Both WAF rules remain live. (§2.5) |
| **Pre-2023 / acquisition-date lanes (#190, #261)** | #190 (201,255 unsourced Top Shot moments classifiable via Dune) blocked on the `CLOUDFLARE_API_TOKEN` worker secret; **#261 NEW** — acquisition-date fill for held moments, blocked on Dune credits until ~12-13. (§2.3) |
| **Physical cards / Panini paper (new prototype)** | An off-by-default physical-cards prototype (valuation, backtest, cert, holdings, eBay module, Courtyard probes) + a Panini paper crosswalk (23/23 card numbers matched to published checklists). Scoping + handoffs in Project docs. (§2.8) |
| **ISR failed-render caching (#249)** | BURST CASE 11-17: a sitemap-walking crawler produced ~100 panel read timeouts in ~2 min, each cached for its ISR window and served to the next visitors. #33-class, per-page; measure-first before a segment-semantics fix. (§2.3) |
| **Live trust — user-facing CLEAR, 0 breaches** | `topshot_impossible_parallel_serials` 0; `v_fmv_sanity_flags` 0; `edition_integrity_flags` 8; `candy_sales_stale` 6.3 h / ok; no UNKNOWN. (§2.4) |
| **Pricing-cap carried partials** | #209 STALE cap (TS + All Day); #210 thin-sale haircut depth floor — each a partial with a weekly tail. (§2.3) |
| Security | scans clean; user-facing trust clear; CISO remediation mostly shipped; one more dead credential found + neutralized (`GITHUB_ACTIONS_READ_TOKEN`); generic rate-limit rules dropped by decision; #60 (can't revoke anon from net/cron schemas) carried, needs Supabase support (§2.4) |
| Product simplification — READ-ONLY pivot | Cart / Trade Hub / Gifting **DELETED** — verified still absent. (The Trade Room is no-custody, signed, user-to-user; races closed #250.) (§2.9) |
| SEO | #66 — code items done; the **accuracy half of the re-open trigger is now MET** (`fmv_accuracy_weekly` Top Shot HIGH 80.1 ≥ 75); external links still held pending #234's relabel. (§2.3) |
| Tech debt / refactor | Monoliths re-measured: DashboardClient **3,175** / SniperClient **2,362** / CollectionAnalyticsClient **2,050** / CollectionTabClient **1,984** / MarketClient **1,398** (§3) |
| DB-size baseline | The June ~4.2 GB baseline doc is still stale; operating ~55–57 GB on the Panini walk. Reset it (§2.6) |
| Deferred hardening (intentional) | Public INSERT-policy tables; `owner_key`→`user_id`; Golazos `highest_offer` gap (settled); `INGEST_SECRET_TOKEN` rotation owed; `buildTopshotPoolPayload` fabricated-divisor (latent, no live caller) |

---

## 2. Critical path — start here

Go-live is **operationally done** (public + self-serve). The forward plan is **`docs/strategy/roadmap-2026-10-17.md`** (canonical; accuracy is the GATE) plus **`docs/strategy/go-live-2026-09.md`**, now amended by the **11-22 strategy read** (`docs/strategy/strategy-2026-11-22.md`): the Top Shot gate is realised-sales accuracy (HIGH and MEDIUM each ≥ 70 % within ±25 % for four consecutive weekly reads, plus a drop-day ≥ 70 %, plus M3–M11), and All Day's M2 no longer gates Top Shot. The binding user bar is **100+ WAU**, and **outreach is off** (Trevor, 10-14).

### 2.1 Launch + activation — the Dame Time surge did NOT retain; the activation layer is the new bet — `Severity: High · Effort: Medium (built + measured, no outreach by directive)`

Read-only tabs are anonymous for the published Flow collections (+Candy overview, +Panini); cost-basis/P&L, saved wallets, watchlist, `/dashboard/*`, the Trade Room, and every mutation stay behind sign-in.

- **Rolling-7-day read (11-13..11-20, `scripts/demand-read.sql`, read 11-20):** **197 human browsers / 285 visits** (1,909 crawler-burst visits excluded), **78 engaged browsers** (from 134), **20 external signed-in users** (down from 36, up from the pre-Dame 5), **3 signups** (down from 21; 2 saved a wallet, the 11-14 Google signup did not), **0 concierge human messages** (from 19 — a headless open+close on 11-20 confirmed the instrument is live, so the zero is real). Sources: direct 240 (186) · Google 24 (21) · ChatGPT 12 (6) · X 7 (5).
- **The honest verdict:** the Dame Time event (locked 11-10) spiked both acquisition and activation, but the surge did not durably retain — signups collapsed and X traffic evaporated once the event ended. The 11-17 review found 0 of 5 new signups returned on a second day. External signed-in users held at 20, a retained residual above the floor, but well short of the 100-WAU gate.
- **The response — an activation plumbing layer (shipped 11-17 → 11-18):** the Day-1 wallet email (live 11-18, 2 sent + delivered); a weekly email to **53 eligible members** (first firing Mon 11-23) carrying a per-member **player deal-alert** line (`/alerts?from=email&collection=…&player=…`); an **"Is this your collection?" binder save card** after a signed-out look-up; a no-account edition look-up leading the edition prompt; `utm_source=email` on email links; Day-1 email ON.
- **Accuracy (the gate, redefined 11-22):** on `fmv_accuracy_weekly` (within ±25 %), wk 11-09 Top Shot HIGH **80.1** / MEDIUM **74.1** both cleared the new 70 % bar for the first time; All Day ALL 62.8 / HIGH 76.8. The old share-series legs (11-07, 16 d old) still read Top Shot 45.6 / All Day 26.8. ⚠ Read the series, not the leg.

The critical-path read is now a sober one: the first real demand event did not convert into retained users on its own, so the bet has shifted from "repeatable events" to "an activation layer that gives arriving/one-time traffic a reason to come back" (emails, deal-alerts, the binder card). The single most important line in the next report is the **~11-24 read**: the 11-23 weekly email's `sent` vs ~50–53 eligible, `alert_player` payloads, `utm_source=email` visits, and `alert_subscriptions` created after 11-23. Hold outreach until the 100-WAU gate opens. **The next challenge is deferred** by decision.

### 2.2 Public intelligence surfaces — 39 public — `Severity: n/a (shipped) · context`

All 39 built surface dirs in `app/insights/` are public (measured this run: 39 surface `page.tsx`, unchanged; 40 including the `/insights` index page). The per-collection squeeze split persists so a crawler/unfurler sees the right collection (the 10-27 architecture note). Carried honesty risks `#50` (`/insights/pack-reality` ranker) and `#33`-class (ISR bakes a failed read into the `revalidate` window — now also tracked as the per-page **#249**) remain as standing design considerations.

### 2.3 Data-intelligence — the gate redefinition + the Candy cluster drain — `Severity: Medium (correctness) · Effort: mixed`

**FMV HIGH/MEDIUM counts (11-23 overnight pass):** Panini 23,464 (HIGH 2,536 + MED 20,928), NBA Top Shot 7,160 (HIGH 1,820 + MED 5,340), NFL All Day 1,817 (HIGH 293 + MED 1,524), Pinnacle 930 (HIGH 241 + MED 689), Candy 33 (MEDIUM 33 / LOW 952 / STALE 2,082 — recovered from 2 last week as the on-chain capture reopened sales), Golazos 1, UFC 0 (closed-market honest label; STALE 582 / NO_DATA 43 — market on Aptos since 11-15).

**Shipped / landed since last week:**

- **The Top Shot gate was REDEFINED (11-22 strategy read).** Gate = realised-sales accuracy: HIGH and MEDIUM each ≥ 70 % within ±25 % for four consecutive weekly reads, plus one drop-day ≥ 70 % at sale, plus M3–M11. **All Day's M2 no longer holds Top Shot.** 1 of 4 weeks met at decision. A proposed "maintenance mode" for Panini/Pinnacle/Golazos/UFC was reversed the same morning — every collection keeps being built out, under a standing lane budget (318 pg_cron jobs baseline; a new job ships only beside a retirement). (`docs/strategy/strategy-2026-11-22.md` §4.)
- **#256 — Candy on-chain capture RESOLVED (11-22).** The falsifier tripped: an archive-node census found **68 Candy fills on 7Aru (62 buys + 6 accepted bids, ~45 SOL) and 1 Tensor bid fill**, none in `sales` — for the week 11-15..11-22 that is **57 of 194 Candy sales and $3,046 of $6,985 (~44 % of the dollars)**. Now captured forward + back-filled via `/api/ingest/candy-chain-sales` (hourly; `sales.marketplace` `solana_7aru` / `tensor`). This reopened real Candy FMV (HIGH+MED 2 → 33).
- **#259 — Candy multi-mint re-key RESOLVED (11-17).** The census re-read / re-keyed the listed editions; the re-measure SQL reads 0 editions / 0 cards over circulation.
- **#257 — legacy Candy asks RESOLVED (11-21).** 0 of 917 active Magic Eden asks unseen > 3 days; the one straggler retired one-off. Watch query reopens it on a non-zero read.
- **#260 — Top Shot ASK_ONLY old-sale cap RESOLVED (11-17, found while building `/trades/compare`).** A Top Shot ASK_ONLY price with no 180-day sale is capped at its last market sale of any age; 151 rows restated ($37,623.78 → $21,073.88), drift guard re-registered.

**New / open:**

- **`#234` — relabel from measured accuracy (OPEN).** The first post-11-04 week (11-09) is in: Top Shot within ±25 % ALL 70.3 · HIGH 80.1 · MEDIUM 74.1 · LOW 57.0 (the ASK_ONLY 18.4 is an instrument artifact from the 11-11 drop scored against launch-hour asks; established editions 60.9). All Day 11-09 ALL 62.8 · HIGH 76.8. Rule decided; the relabel needs two agreeing post-11-04 weeks, so the **earliest relabel is after the Mon 11-23 run**. Handoffs: `docs/handoff-2026-11-04-*`.
- **`#261` — acquisition DATE we cannot prove from our own tables (OPEN, NEW 11-16, blocked on Dune credits).** The binder's "Acquired" is `COALESCE(moment_acquisitions.acquired_date, wmc.acquired_at)`; `wmc.acquired_at` alone is NULL on 13,220 of one founder wallet's 15,793. A new moment's sale/pull is now proven at first sight before any `unknown` placeholder; the historical backfill is **blocked on Dune credits until Dec 13 4 PM PT (= 12-14 00:00 UTC)**.
- **`#190` — pre-2023 custodial pack opens (OPEN, reopened 11-14, needs Trevor).** 56 saved wallets hold 305,985 Top Shot moments, **201,255 with no `moment_acquisitions` row** and 24,812 gift/unknown with no price; Dune `flow.cadence_events` can classify each. **Blocker:** the Dune→DB worker lane needs the `CLOUDFLARE_API_TOKEN` repo secret (never set), or the query id added to the worker var in the Cloudflare dashboard.
- **`#249` — ISR caches a FAILED render for its whole window (OPEN, #33-class).** BURST CASE 11-17: a crawler walked the sitemap (`/[collection]/pack/dist/*` + `/profile/*` alphabetically) and in ~2 minutes produced ~100 panel read timeouts across pack-detail (9 panels, up to 17 each), entity market-cap tiles (~60), profile bundles and player hubs — 5× the prior week's whole pack-panel count, each cached for its ISR window and served to the next visitors. **Measure first**, then either close as not-worth-it or ship a preview-verified fix where a failed regeneration keeps the last good render.
- **`#258` — Candy namesake collision (OPEN, watching).** Two "Luis Garcia" players have two URLs; a future "Luis García" Candy edition could mislink. The watch query is **still empty (0)** as of 11-22; fix (team-aware name arm) only if it fires.
- **`#209 / #210` — pricing-cap partials (carried).** #209 (TS + All Day STALE cap): price + basis-line halves shipped; weekly reads still thin. #210 (thin-sale haircut depth floor): Top Shot exit met; All Day cut + the depth term stay open (no listing-history input to backtest a real depth term).
- **`#66` — SEO (PARTIAL, needs Trevor):** every code item done; the **accuracy half of the re-open trigger is now MET** (`fmv_accuracy_weekly` Top Shot HIGH read 75.5 wk 11-02 and **80.1 wk 11-09**, both ≥ 75). The other half — #234's relabel — has not landed, so external-link outreach stays held.

### 2.4 Security, confidentiality + test infrastructure — `Severity: Medium (clean scans; 0 breaches) · Effort: mostly landed`

- **The CISO security-audit remediation (#229, PARTIAL — most shipped).** The full vuln/pentest pass (`docs/audits/2026-11-04-ciso-security-audit.md`) shipped the trade-room relay guard, wallet-verification binding, input validation, `.npmrc` hardening, constant-time secret compares, Dependabot, WAF deny rules, 9 sensitive env secrets, MFA across every provider, and `main`-branch protection. The two generic RATE-LIMIT rules are **decided DROPPED, not pending** (both abusive clients defeat a per-IP limit, and they are paid under "no infra spend pre-revenue"). One more dead credential found — `GITHUB_ACTIONS_READ_TOKEN` (created 08-30) answers 401; the sentinel arm now reads the public repo anonymously, so rotating it is optional. **Still Trevor's:** the secret-rotation TIERS in `docs/operations/secret-rotation-plan-2026-11.md`. Re-audit cadence quarterly, next 2027-02-04.
- **Security scans clean** (invariants, anon-write holes, rls-off-base-tables, secdef-anon all `[]`, plus search-path/txn-control/cursor-rewind/suppression drift all `[]`, per `rpc_ops_snapshot.security`, the 11-23 pass). A scratch-table RLS-off smoke burst 11-22 23:13–23:28Z self-healed by the `:47` selfheal audit, as the prior steer predicted; the table is now absent.
- **Live trust — user-facing clear, 0 breaches.** `topshot_impossible_parallel_serials` 0; `v_fmv_sanity_flags` **0**; `edition_integrity_flags` **8** (bar 250); `candy_sales_stale` 6.3 h / ok; `unmapped_resolution_backlog_max` 0; **no UNKNOWN rows**. (Last week carried 1 dispositioned `candy_sales_stale` breach; the Candy market reopening on-chain cleared it.)
- **`#60` (carried):** Postgres cannot revoke `anon`/`authenticated` from the `net`/`cron` schemas; real fix needs Supabase support.
- **DB-invariant SQL layer: 317 `supabase/tests/*.sql` files** (+3, measured this run). CI is **21 jobs** in `ci.yml` (unchanged). **Never lower thresholds to green a build.**

### 2.5 Automation / asset hygiene — `Severity: Low–Medium · Effort: ongoing`

⚠ **`#235` — an unnamed external crawler degrades the whole site (OPEN, RECURRED).** Both WAF rules are live — a Vercel rule `Entity page sweep` (keyed on JA4 digest, Challenge) and a custom Challenge on the Tencent Cloud ASN. But the per-minute half of the done-check **FAILS**: re-read 11-22, the multi-region sweeper recurred on **11-16 ~10:10–10:14 PM PT (06:10–06:14Z 11-17) through 17 edge regions** (gru1 637 · sfo1 541 · sin1 316 · cle1 302 · fra1 228 · …), peaking ≈ 500+/min — so #235 STAYS OPEN. ⚠ Challenge will also challenge our own cloud QA sweeps — keep `RPC_QA_CONC` low and read a challenge page in a sweep as this rule, not an outage. **Exit:** a week with no minute > 400 invocations and Tencent `allow` ≈ 0.

⚠ **`#34` — Sentry dark; no-spend DECIDED** — the `window.onerror`/rejection beacon → `usage_events.client_error` is the detector; the 11-23 pass reads ~1 benign event / 24 h (Sentry dark since 08-18). ⭐ **`#114` dashboards** stay ported to claude.ai artifacts (desktop-session work). The true-mobile QA instrument (`scripts/qa/mobile-sweep.mjs`, real Chromium at 390/320 px) remains the only real mobile instrument.

### 2.6 Overnight operational queue — `Severity: Low–High (mixed) · Effort: mixed`

Health scans GREEN on the 11-23 pass (0 stalled pipelines). Open items for Trevor / operator / Claude Code:

| Item | Issue | Severity | Notes |
|---|---|---|---|
| **#190 — Dune→DB lane** | Pre-2023 custodial pack opens addressable via Dune; worker lane not deployable. | Med (needs Trevor) | Set `CLOUDFLARE_API_TOKEN` repo secret, or add the query id in the Cloudflare dashboard. |
| **#261 — acquisition-date backfill** | Held moments whose acquisition date we can't prove from our own tables; new-moment path closed, historical backfill blocked. | Med (needs data) | Blocked on Dune credits until ~Dec 13 4 PM PT. |
| **#229 — secret-rotation tiers** | MFA/WAF/branch-protection/Dependabot all done; the rotation TIERS are Trevor's. | Med (operator) | `docs/operations/secret-rotation-plan-2026-11.md`. Do before marketing. |
| **#58 OpenSea key** | Candy book now fed on-chain (#256), so the ME key is optional. | Low (optional) | Candy re-verify ~11-27. |
| **S1 / S3 / S6 + C2 + #22** | console token rotation (cron-job.org, GHA, Vercel) + CAN-SPAM postal address + the Dapper session rotation. | Med (operator) | Do before marketing; digests stay flag-off until C2 exists. |
| **DB-size baseline doc** | The June ~4.2 GB baseline reads as a ~13× regression against ~55–57 GB operating. | Low (housekeeping) | Reset it; keep the Panini walk on watch. |

*(Closed this week and off the queue: **#248** wmc-fmv reconcile cost close-out — RESOLVED 11-16, all three exits passed; **#253** `refresh_panini_sale_feed_status` timeout — CLOSED 11-18, the `:53` slot move met the exit (0 kills both parities).)*

### 2.7 Pack EV / pack-viz — `Severity: Low–Medium · Effort: upstream-blocked`

Pack-EV surfaces label rows for packs nobody can buy and disclose AllDay/Golazos EV as an original-supply model; Candy leads with Typical-Pull median. ⚠ **`#218` WORSENED (11-17):** Dapper Studio GraphQL now answers **HTTP 530 to every request, also from a residential box** — it fails the TS/AD/Golazos pack-sales walkers, Golazos pack listings + opens, Pinnacle pack opens, and AD/Golazos pack EV; Pinnacle images still load (edge cache + edition-page fallback), the TS/AD ask books keep moving via Atlas, and chain pack sales are current. The upstream freeze is Dapper's — the Sniper reads book freshness from on-chain secondary sales and marks a ≥ 2 h stale book as frozen. This is an upstream outage, not an RPC regression.

### 2.8 Chain foundation — Candy LIVE (sales reopened on-chain), Panini walked heavily, physical-cards prototype, live giveaways — `Severity: Low (shipped) · Effort: landed`

- **Candy / Solana — LIVE; sales reopened on-chain (#256):** `CANDY_MLB_PUBLIC = true` (verified this run). The Magic Eden book stayed frozen since 10-11, but the on-chain 7Aru/Tensor capture recovered real Candy sales (~44 % of the week's dollars) and lifted live FMV HIGH+MED from 2 → 33. The data-quality cluster (#256–#259) largely drained; #258's namesake watch stays empty. Candy editions 21,522.
- **Panini — the WC Prizm + basketball plane** (`PANINI_PUBLIC = true`, verified this run). Another heavy collector-walk week: editions **47,674 → 55,857 (+~8,183)**, the main durable DB-size driver.
- **Physical cards / Panini paper — NEW prototype (off by default).** A physical-cards prototype (valuation, backtest, cert, holdings, an eBay listings module, Courtyard probes) shipped off-by-default this week, alongside a Panini paper crosswalk linking 2021 NFL Prizm / Donruss Optic digital cards to their paper names (23/23 card numbers matched to published checklists). Scoping + handoffs live in Project docs (`claude/physical-cards-scoping-2026-11-22.md`, `claude/handoff-2026-11-22-physical-cards-prototype.md`).
- **Collector-utility layer:** the no-custody user-to-user Trade Room (signing live since 10-31, races row-locked #250), the trade-in finder, follow-a-player, player checklists, and trophy challenges.
- **Giveaway instant delivery — LIVE and PROVEN (11-10).** Vault `0x38300125d58f76d1`, `RPC_GIVEAWAY_INSTANT_DELIVERY=1`.
- **Rewards economy — exists but PAUSED (dial-in). Chain-abstraction Phases A–F complete.**

### 2.9 Read-only product pivot — carried, verified still in effect — `Severity: n/a (landed) · Effort: (done)`

Cart, Trade Hub, and Gifting remain **deleted from the tree** — verified this run by absence: `lib/cart`, `lib/trade-escrow`, `app/dashboard/trade-hub`, `app/dashboard/gift`, `lib/blazers-trivia.ts`, `docs/FREEZE.md` all absent. The product is read-only except for admin-signed giveaway delivery and the **no-custody user Trade Room** (`/trades`; signing live since 10-31, kill switch `RPC_TRADE_ROOM_EXECUTE`, races closed #250).

---

## 3. Known issues — by theme

Severity/effort are suggestions. "#" = the item number in `docs/reference/known-issues.md`. **§9 has the verified open/moved status.**

### Launch / activation (the whole critical path)

| # | Issue | Severity | Effort |
|---|---|---|---|
| — | **Traffic / WAU.** Dame Time surge did NOT retain (signups 21 → 3, signed-in 36 → 20); activation email layer shipped, first read ~11-24. **No outreach** (10-14). | **High** | Medium (assets built, retention unproven) |
| — | **Go-live bars (redefined 11-22).** Top Shot gate = realised-sales accuracy (HIGH+MED each ≥ 70 % ×25 for 4 weeks + a drop-day); 1 of 4 met. All Day M2 no longer gates. Demand is the binding bar. | High | Mixed |

### Data completeness / accuracy / pricing

| # | Issue | Severity | Effort |
|---|---|---|---|
| 234 | FMV confidence labels are a 30-day sales COUNT, not measured accuracy; relabel RULE decided; wk 11-09 HIGH 80.1 / MED 74.1; earliest relabel after the Mon 11-23 read. | **Med–High (open)** | Measurement + relabel |
| 261 | Acquisition DATE unprovable from our own tables for held moments; new-moment path closed; historical backfill blocked on Dune credits (~12-13). | Med (open, blocked) | Dune lane |
| 190 | Pre-2023 custodial pack opens — Dune can classify 201,255 unsourced moments; blocked on a Cloudflare worker secret. | Med (open) | Operator secret + Dune→DB lane |
| 249 | ISR caches a failed pack-dist / entity-page render for its whole window (#33-class, per-page); burst case 11-17 (~100 timeouts in 2 min). | Low–Med (open) | Measure-first, segment-semantics fix |
| 258 | Candy namesake collision (two "Luis Garcia"); future mislink risk; watch empty. | Low (open, watching) | Team-aware name arm if it fires |
| 209 | Top Shot + All Day STALE cap; price + basis-line halves shipped; weekly reads still thin. | Low–Med (partial) | Mostly landed |
| 210 | Thin-sale haircut depth floor (0-sale cells 0.75); TS exit met; All Day cut + depth term open. | Low–Med (partial) | Measurement tail |
| 66 | Zero external links (gated on the accuracy gate); code items done; **accuracy half of trigger now MET** (HIGH 80.1); relabel (#234) half pending. | Med | Off-platform (not code) |

### Plumbing / instruments / cost

| # | Issue | Severity | Effort |
|---|---|---|---|
| 228 | Cold-whale `/api/collection-snapshot` + `/api/wallet-summary` timeouts; index swap + 20 s wait + CDN stale window shipped; watch to a 30-day exit. | Low–Med (partial) | Stored-snapshot lever if it fires |
| 218 | Dapper Studio pack index — **WORSENED: GraphQL 530 to every request**; Sniper reads book freshness from on-chain sales; upstream outage is Dapper's. | Low–Med (partial, upstream) | Upstream-blocked |

### Security / operator

| # | Issue | Severity | Effort |
|---|---|---|---|
| 229 | CISO audit remediation mostly shipped; generic rate-limit rules dropped by decision; rotation TIERS Trevor's. | Med (partial) | Mostly landed + operator |
| 235 | Unnamed multi-region crawler; both WAF rules live; **RECURRED 11-16 via 17 regions** — per-minute done-check fails. | Med (open) | WAF watch |
| 60 | Cannot revoke anon/authenticated from net/cron schemas; needs Supabase support. | Low–Med | External |
| 34 | Sentry dark (beacon is detector; ~1 benign event / 24 h). | Med | Decided (no spend) |

### Tech debt / refactor

| # | Issue | Severity | Effort |
|---|---|---|---|
| 14 / 10 | Monolith page refactor — re-measured this run: DashboardClient **3,175**, SniperClient **2,362**, CollectionAnalyticsClient **2,050**, CollectionTabClient **1,984**, MarketClient **1,398**. | Low–Medium | Large |

### Stalled / scaffolded + deferred hardening

- Cart / Trade Hub / Gifting — **DELETED, verified still absent** (the Trade Room is a separate no-custody signed feature).
- Deferred hardening (intentional): `email_subscribers`/`outbound_clicks`/`portfolio_snapshots`/`support_conversations` public INSERT policies; `user_achievements`+`watchlist_items` still on `owner_key` (text); Golazos `highest_offer` gap SETTLED (no offer source — do NOT build the indexer); `sales-serial-backfill` substring-token check (latent dead code; `INGEST_SECRET_TOKEN` rotation owed); `buildTopshotPoolPayload` fabricated-divisor (latent, no live caller — exit when the pool lane revives, #65); `solUsdOn` historical-vs-spot basis (FIXED 11-03 — `solUsdOnWithBasis()`).

### Architecture notes worth tracking

- **Two "collection vocabulary" and two "confidence vocabulary" footguns** persist by design. Re-read `CLAUDE.md` before any new query. (The FMV-count keys use `panini_blockchain`, not `panini`.)
- **Flowty is fully retired (10-30); Dapper Studio GraphQL is now 530 to everyone (#218)** — All Day / Golazos / Pinnacle asks come from Dapper's own storefronts / Atlas; pack walkers are upstream-blocked.
- **Supabase compute is `LARGE`** (resized from SMALL 2026-09-20). Any pre-09-20 finding citing the SMALL-tier disk-IO floor is stale — re-derive.
- **The June ~4.2 GB DB-size baseline doc is badly stale** — the DB now operates at ~55–57 GB on the Panini walk; reset the baseline.
- **A metadata fix is not a page fix** — verify the rendered BODY, not the `<head>`. All green in `tsc`/vitest/lint but only a real render / live request says so; see `architecture-notes.md`.
- **Eight+ caller sources** — including a laptop collector-walk runner and cron-job.org — are invisible to a repo grep. Enumerate all before calling any ingest dead.

---

## 4. Prioritized next actions — **canonical**

`CLAUDE.md`'s old list is replaced by **`docs/strategy/roadmap-2026-10-17.md`** (canonical; accuracy-is-the-gate), **`docs/strategy/go-live-2026-09.md`**, and the **11-22 gate redefinition** (`docs/strategy/strategy-2026-11-22.md`):

| Phase | Action | Status |
|---|---|---|
| Gate | **Accuracy is the GATE — now Top Shot realised-sales accuracy: HIGH+MED each ≥ 70 % within ±25 % for 4 consecutive weeks + a drop-day ≥ 70 % + M3–M11. All Day M2 no longer gates.** | **1 of 4 weeks met at the 11-22 decision; wk 11-09 HIGH 80.1 / MED 74.1 both cleared 70 %. Earliest relabel after Mon 11-23. The HIGH/MED-share legs (11-07): TS 45.6, All Day 26.8, Panini 45.7.** |
| Go-live | **M1–M11 bars.** | Latency/beacon/mobile bars met in prior cycles; accuracy gate advancing on the new instrument; demand is the binding bar. |
| 1 | **Prove the product with real users — 100+ WAU; no outreach (10-14).** | **Open — the critical path. Dame Time did NOT retain (signups 21 → 3); the activation email layer (Day-1, weekly, player deal-alerts, binder card) is the new bet — first read ~11-24.** |
| 2 | Cost / latency / saturation levers. | **Watch — DB ~55–57 GB and climbing on the Panini walk, tier LARGE; reset the stale size baseline doc. #248/#253 both closed this week.** |
| 3 | Durable debt. | Heavy advance — the Candy data-quality cluster drained (#256/#257/#259), the on-chain capture reopened Candy sales, the Top Shot ASK_ONLY cap (#260), the gate redefinition. |
| 4 | Chain two, readiness-gated. | Candy LIVE (sales reopened on-chain); Panini walked heavily; a physical-cards prototype off-by-default; giveaways live; Rewards paused/dial-in. |

**Standing guardrails:** no paywall/Stripe until 100+ WAU; no infra spend pre-revenue; **no outreach** (10-14); **verify pages by rendered DOM, not HTTP 200**; **before gating/short-circuiting any route, enumerate EVERY caller** (eight+ sources).

**Housekeeping still outstanding:** read the ~11-24 activation-email conversion (the durability follow-on); land #234's relabel after the Mon 11-23 accuracy read; finish the #229 secret-rotation tiers + S1/S3/S6 console tokens + C2 postal address + #22 Dapper session; set the #190 Cloudflare worker secret; wait on Dune credits for #261 (~12-13); keep the #235 WAF watch and the #249 ISR-cache measure; track the #218 Dapper Studio upstream outage; and reset the stale DB-size baseline doc.

---

## 5. In-code TODO inventory

A first-hand scan over tracked non-docs source (`git ls-files` → `*.{ts,tsx,js,jsx,mjs,cjs,sql,toml,css}`, excluding `docs/`; `node_modules`/`.next`/`.git` are untracked-excluded; **7,553** tracked non-docs source files) with `grep -nE '\b(TODO|FIXME|HACK|XXX)\b'` found **6 match lines, none actionable** — unchanged in character from prior weeks. (TODO 5 lines, XXX 1 line carrying two format-literal hits; FIXME 0, HACK 0.)

### 5a. Narrative / resolved-work references + the format-literal false positive (6 lines)

- `app/api/rtr/lock-roi/route.ts:38` — "v2 folds in the two signals the v1 TODO called out — TIER and SERIAL" (describes resolved work).
- `lib/chains/solana/normalize.ts:49` — "It was previously held as a TODO placeholder…" (resolved).
- `lib/format.ts:6` — the `"$X,XXX.XX" / "-$X,XXX.XX"` format doc comment; the `XXX` here is a format-string literal (twice), the exact false positive the task names.
- `lib/rtr-lock-roi-weights.ts:7` — "resolves the standing 'calibrate the absolute curve' TODO…" (resolved).
- `supabase/migrations/20260713050000_audit_20260713_wmc_team_name_denorm.sql:4` — "Motivation (was a TODO in components/collection/CollectionMomentTable.tsx):" (shipped; past-tense reference).
- `supabase/migrations/20260919173527_panini_bridge_candidates…sql:30` — "FOUR GAPS THIS VIEW DELIBERATELY DOES NOT PAPER OVER — each is a pre-flip decision, **not a TODO**" (explicitly not a marker).

> **Net change since last week:** none of consequence. Live application code has **zero actionable** TODO/FIXME/HACK/XXX markers. `scripts/`, `workers/` (non-vendored) and `supabase/functions/` scanned clean. `TODO_`-prefixed launch-flag guard strings (which do not match `\bTODO\b`) persist by design.

---

## 6. Resolved / no action needed

Verified against the register STATUS INDEX, the 11-23 overnight metrics, and the demand/activity reviews:

**Newly resolved / landed / decided since last week (2026-11-16 → 2026-11-23):**
- **#248** — `reconcile_wmc_fmv_for_wallet` estate-wide IO cost: RESOLVED 11-16 (scheduled close-out; all three last exits pass — job 617's first daily run fixed 1,565 rows vs ~7,040 per 2-hourly, net-negative IO confirmed).
- **#253** — `refresh_panini_sale_feed_status` killed ~once/day: CLOSED 11-18 (the `:53` slot move met the focus-steer exit — jobid 714 both parities ≲ 35 s, 0 kills over the window).
- **#256** — Candy OpenSea / on-chain sales not captured: RESOLVED 11-22 (falsifier found 68 7Aru/Tensor fills = ~44 % of Candy dollars, now captured hourly + back-filled; live HIGH+MED 2 → 33).
- **#257** — legacy Candy asks feed the FMV cap: RESOLVED 11-21 (0 of 917 active ME asks unseen > 3 days; watch reopens on a non-zero read).
- **#259** — Candy multi-mint editions merge different cards: RESOLVED 11-17 (re-measure SQL reads 0 editions / 0 over-circ cards).
- **#260** — Top Shot ASK_ONLY old-sale cap (NEW + CLOSED 11-17): a Top Shot ASK_ONLY price with no 180-day sale is capped at its last market sale of any age; 151 rows restated; drift guard re-registered.

**Note on churn:** the register grew 257 → 259 numbered items (+2: #260 shipped-and-closed, #261 opened), closed +6 (241 → 247), and open+partial fell **16 → 12**. This week was the inverse of last week's discovery surge: the concentrated Candy data-quality cluster that opened last week largely *drained*, and two cost items (#248/#253) closed. The one new open item (#261) is a capability/data gap blocked on Dune credits, not a regression.

---

## 7. Suggested sequence

A pragmatic order under **accuracy-is-the-gate** + the redefined go-live bars (outreach off, gate 100+ WAU):

1. **Read the ~11-24 activation-email conversion (the durability follow-on).** The Dame Time surge did not retain, so the single most important read is whether the new email layer (Day-1 + the 11-23 weekly to 53 members + the player deal-alert line) converts: the weekly email's `sent` vs eligible, `utm_source=email` visits, `alert_subscriptions` created after 11-23, and whether the named returnees come back. This is now the highest-leverage product work.
2. **Land the #234 relabel after the Mon 11-23 `fmv_accuracy_weekly` run** (the first with two agreeing post-11-04 weeks), making each label's promise match its segment's within-±25 %. HIGH and MEDIUM both cleared 70 % on the 11-09 week — this is the "pricing is the anchor" work and it directly advances the redefined Top Shot gate. Keep labels INTERNAL.
3. **Keep the #235 WAF watch** (the sweeper recurred via 17 regions 11-16) and **measure #249** (count ISR failed-render incidence in Vercel logs, including the burst case) before deciding a segment-semantics fix.
4. **Track the #218 Dapper Studio upstream outage** (530 to everyone) — nothing to ship, but it degrades several pack surfaces; confirm the honest-degradation paths hold.
5. **Finish the CISO tail (#229):** the secret-rotation tiers + S1/S3/S6 console tokens + C2 postal address + #22 Dapper session (operator/Trevor) — before any marketing.
6. **Set / wait on the capability unblocks:** #190's `CLOUDFLARE_API_TOKEN` (the Dune→DB lane) and #261's Dune credits (~12-13); #58's OpenSea key is now optional (Candy fed on-chain).
7. **Reset the stale DB-size baseline doc** (~4.2 GB June → operating ~55–57 GB) and keep the Panini walk on watch.

---

## 8. Notes from verification

- **Sandbox / device shell active this run.** `git`/`grep`/`wc`/`ls` all work over the connected repo; counts are first-hand. **830 commits** since 2026-11-16 (`git log --since`); mount HEAD `a46e706c6` 2026-11-23 09:12 PT (Claude, RPC night pass). Authors: Claude 723, Trevor 72, rpc-daytime-monitor 14, rpc-overnight 6, rpc-migration-autorecover 5, Cowork nightly 2, surface-QA 2, overnight 2, night-pass 2, jamesdillonbond 1, Opus overnight 1. The mount is level with `origin/main` (both `a46e706c6`).
- **Counts measured this run:** CI = **21** jobs under `jobs:` in `.github/workflows/ci.yml` (unchanged; the 21 are changes, memory-docs, docs-tests, inherited-status, typecheck, eslint-ratchet, cadence-escrow-tests, unit-tests-shard, unit-tests, component-tests-shard, component-tests, workflow-lint, build-render, worker-tests, workers-typecheck, db-tests, ledger-guard, register-guard, inbox-guard, tree-corruption, edge-deno). DB-invariant test files = **317** (`supabase/tests/*.sql`, `ls`, +3). `app/insights/*/page.tsx` surface dirs = **39** (unchanged; 40 `page.tsx` including the `/insights` index). Monoliths re-measured (`wc -l`): DashboardClient 3,175 / SniperClient 2,362 / CollectionAnalyticsClient 2,050 / CollectionTabClient 1,984 / MarketClient 1,398.
- **Live metrics (from the 2026-11-23 ~1:10 AM PT overnight pass):** DB size **56,823 MB** (~56.8 GB; up from 53,881 last week, +1,093 vs the prior overnight read — the Panini walk; operating band now ~55–57 GB). Trust: **0 breaches, no UNKNOWN**; `candy_sales_stale` 6.3 h / ok; `v_fmv_sanity_flags` 0; `topshot_impossible_parallel_serials` 0; `edition_integrity_flags` **8** (bar 250). FMV HIGH+MED by collection: Panini 23,464, NBA 7,160, NFL 1,817, Pinnacle 930, Candy 33, Golazos 1, UFC 0. Editions: Panini **55,857** (+~8,183 wk), Candy 21,522, NBA 15,151, NFL 6,190, Golazos 575, UFC 625. Client-error beacon ~1 benign event / 24 h (Sentry dark since 08-18). Vercel: prod `245f4cb1` READY; 13 runtime-error groups all count 1–9, all honest read-timeout degradations, nothing new/clustered. Security clean (all four arms + drift checks `[]`). 0 stalled pipelines; 8 info alerts (Atlas/Dapper Cloudflare-403 base-rate, all designed outcomes).
- **Accuracy — two numbers.** The HIGH/MEDIUM-share weekly-mean legs (`rpc_trust_health_history`, 11-07 block) are the latest file-blessed read and are **16 days old** (no FMV route change re-read them this week): Top Shot 45.6, All Day 26.8, Pinnacle 32.7, Candy 48.1 (drained; live HIGH+MED 33 after the on-chain capture), Panini 45.7, Golazos 0.2, UFC 0.0. The realised-sales number (`fmv_accuracy_weekly`, now the gate, within ±25 %), wk 11-09: Top Shot ALL 70.3 / HIGH 80.1 / MEDIUM 74.1 / LOW 57.0 / ASK_ONLY 18.4 (artifact); All Day ALL 62.8 / HIGH 76.8. Baseline wk 10-26: ALL 68.2 / HIGH 74.3 / MEDIUM 69.1 / LOW 54.9 / ASK_ONLY 48.6. **Read a series, not a leg.**
- **Demand (rolling 11-13..11-20, read 11-20):** 197 browsers / 285 visits (1,909 crawler-burst excluded), 78 engaged, 20 external signed-in (↓ from 36, ↑ from pre-Dame 5), 3 signups (↓ from 21), 0 concierge human messages. Dame Time cohort (19 accounts): 13 active in the week; 0 of 5 new signups returned on a second day (11-17 review). Next read on/after Tue 11-24 (the activation-email conversion test).
- **TODO scan: 6 match lines, 0 actionable** (§5) — tracked non-docs source via `git ls-files` + `grep -nE '\b(TODO|FIXME|HACK|XXX)\b'`; the two `XXX` hits are the `$X,XXX.XX` format literal on one line; the other 5 are past-tense/resolved TODO references.
- **Deletions verified by absence (`test -e`):** `lib/cart`, `lib/trade-escrow`, `app/dashboard/trade-hub`, `app/dashboard/gift`, `lib/blazers-trivia.ts`, `docs/FREEZE.md` — all absent.
- **Launch flags verified:** `lib/launch-flags.ts` `CANDY_MLB_PUBLIC = true`, `PANINI_PUBLIC = true`; Trade Room kill switch `RPC_TRADE_ROOM_EXECUTE` present (`lib/trade-room/execute.ts`).
- **Cited paths spot-checked — one stale reference persists (third week running).** Resolve (no issue): `docs/strategy/{roadmap-2026-10-17,go-live-2026-09,strategy-2026-11-22}.md`, `docs/reference/{known-issues,roadmap-status,architecture-notes}.md`, `docs/audits/2026-11-04-ciso-security-audit.md`, `docs/operations/{secret-rotation-plan-2026-11,flowty-retirement-runbook}.md`, `docs/strategy/features/trading.md`, `scripts/{demand-read.sql,funnel-read.sql}`, `lib/{launch-flags,trade-room/execute,chains/solana/opensea,address,fmv-confidence}.ts`, `app/api/golazos-offers-indexer/route.ts`, `workers/dune-proxy`. ⚠ **Stale:** `docs/proposals/wmc-snapshot-cover-index-swap-STAGED.sql` is still cited in **partial item #228** but is **ABSENT** — the swap it staged was completed via the dashboard on 11-04 (record `20261104161510`), and #228's own text now carries a parenthetical confirming it is done, but the path reference itself has not been removed. (Flagged in the 11-09 and 11-16 reports; still not cleaned up.)
- **Known-issues STATUS INDEX:** its own generated line reads **259 numbered items — 6 open · 6 partial · 247 closed**; the 6 open are **#190, #234, #235, #249, #258, #261**; the 6 partial are **#66, #209, #210, #218, #228, #229**; the newest filed slot is **#261**.
- This report did **not** edit `CLAUDE.md` or any source file and did **not** touch git — it only created this file.

---

## 9. Known-issues reconciliation (verified 2026-11-23)

The register's own generated STATUS INDEX reports **259 numbered items — 6 open · 6 partial · 247 closed**. ⛔ `closed`/`open` means the item *says* so — read its own date stamp. The current open/partial set and the items that moved since last week:

| # | Issue | Index status | Verified status | Evidence |
|---|---|---|---|---|
| 190 | Pre-2023 custodial pack opens | 🟡 **open** | Reopened 11-14; 201,255 unsourced moments classifiable via Dune; blocked on the `CLOUDFLARE_API_TOKEN` worker secret | known-issues #190 |
| 234 | FMV confidence labels are a 30-d sales count, not measured accuracy | 🟡 **open** | First post-11-04 week (11-09) in: TS HIGH 80.1 / MED 74.1 cleared 70 %; relabel earliest after the Mon 11-23 run | known-issues #234 |
| 235 | Unnamed multi-region crawler degrades the site | 🟡 **open** | RECURRED 11-16 via 17 edge regions (~500/min); per-minute done-check fails; both WAF rules live | known-issues #235 |
| 249 | ISR caches a failed pack-dist / entity-page render | 🟡 **open** | BURST CASE 11-17 — a sitemap crawler produced ~100 panel timeouts in ~2 min; measure-first then a fix | known-issues #249 |
| 258 | Candy namesake collision (two "Luis Garcia") | 🟡 **open** | Watching; watch query still empty (0) as of 11-22 | known-issues #258 |
| 261 | Acquisition DATE unprovable from our own tables | 🟡 **open** | NEW 11-16 — new-moment path closed; historical backfill blocked on Dune credits until ~12-13 | known-issues #261 |
| 66 | SEO / zero external links | 🟠 partial | Code done; accuracy half of re-open trigger MET (HIGH 80.1 ≥ 75); #234 relabel half pending | known-issues #66 |
| 209 | Top Shot + All Day STALE cap | 🟠 partial | Price + basis-line halves shipped; weekly reads still thin | known-issues #209 |
| 210 | Thin-sale haircut depth floor | 🟠 partial | TS exit met; All Day cut + depth term open (no listing history to backtest) | known-issues #210 |
| 218 | Dapper Studio pack index froze | 🟠 partial | **WORSENED 11-17** — GraphQL 530 to every request; breaks pack walkers + AD/Golazos pack EV; upstream | known-issues #218 |
| 228 | Cold-whale `/api/collection-snapshot` + `/api/wallet-summary` timeouts | 🟠 partial | Index swap + 20 s wait + CDN stale window shipped; watch to 30-day exit; ⚠ cites a now-absent STAGED.sql | known-issues #228 |
| 229 | 2026-11-04 CISO security audit | 🟠 partial | Remediation mostly shipped; generic rate-limit rules dropped by decision; rotation tiers Trevor's | known-issues #229 |
| 248 | `reconcile_wmc_fmv_for_wallet` estate-wide IO cost | ✅ closed | RESOLVED 11-16 (was open last week) — close-out exits passed, net-negative IO | STATUS INDEX |
| 253 | `refresh_panini_sale_feed_status` killed ~once/day | ✅ closed | CLOSED 11-18 (was open last week) — `:53` slot move, 0 kills | STATUS INDEX |
| 256 | Candy OpenSea / on-chain sales not captured | ✅ closed | RESOLVED 11-22 (was open last week) — 68 7Aru/Tensor fills (~44 % of dollars) now captured | STATUS INDEX |
| 257 | Legacy Candy asks feed the FMV cap | ✅ closed | RESOLVED 11-21 (was open last week) — 0 of 917 unseen > 3 d | STATUS INDEX |
| 259 | Candy MULTI-mint editions merge different cards | ✅ closed | RESOLVED 11-17 (was open last week) — re-measure reads 0 editions | STATUS INDEX |
| 260 | Top Shot ASK_ONLY old-sale cap | ✅ closed | NEW + RESOLVED 11-17 — 151 rows restated; drift guard re-registered | STATUS INDEX |

**Tally (per the register's own STATUS INDEX):** **259 numbered items — 6 open · 6 partial · 247 closed**, newest slot **#261**. Plus the go-live plan, the per-collection accuracy legs (two numbers: the HIGH/MED-share series and realised-sales accuracy), Candy live (sales reopened on-chain) + Panini walked heavily + a physical-cards prototype (off by default) + the collector-utility layer + trophy challenges + live giveaway instant delivery + Rewards paused, **21-job CI**, **317 DB-invariant test files**, and **39 public `/insights` surfaces**.

**Bottom line for `CLAUDE.md`:** another heavy, clean week (830 commits), all interactive Cowork / Claude Code, with the autonomous pass green-and-idle every night. The week's headline is the honest answer to last week's open question — **the Dame Time demand surge did NOT durably retain** (signups 21 → 3, external signed-in 36 → 20, concierge human use to 0) — and the two responses to it: an **activation plumbing layer** (Day-1 + weekly emails, player deal-alerts, a binder save card, a no-account look-up; first conversion read ~11-24) and a **Top Shot gate redefinition** (realised-sales accuracy, HIGH+MED each ≥ 70 % ×25 for 4 weeks + a drop-day; All Day's M2 no longer gates), on which the number is genuinely improving (HIGH 80.1, MEDIUM 74.1 both cleared 70 % on the 11-09 week). The register's open work *shrank* (16 → 12): the Candy data-quality cluster largely drained (**#256/#257/#259** closed), with the on-chain capture fix recovering ~44 % of the week's Candy sales dollars and reopening Candy FMV (2 → 33). Live user-facing trust is clean (0 breaches, 0 impossible serials, 0 FMV sanity flags). The watch-items are the **Dapper Studio upstream outage (#218 worsened to 530-everywhere)**, the **#235 crawler recurrence**, DB growth to ~56.8 GB on the Panini walk, and the operator/Trevor asks (the #229 rotation tiers + S1/S3/S6, C2, #22; the #190/#261 Dune unblocks). **Demand is still the one number that decides everything** — this week it told us events alone do not hold users, so the **~11-24 activation-email conversion read is the single most important line in next week's report.**
