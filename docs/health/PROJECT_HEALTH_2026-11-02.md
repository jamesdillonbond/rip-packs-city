# Rip Packs City — Project Health Report

**Date:** 2026-11-02
**Compiled by:** Claude (Cowork) — automated weekly run
**Sources:** `CLAUDE.md` + `docs/reference/known-issues.md` (generated STATUS INDEX, now reading **223 numbered items — 4 open · 5 partial · 214 closed**, newest slot **#225**), the canonical forward plan `docs/strategy/roadmap-2026-10-17.md`, `docs/reference/roadmap-status.md` (headline-metric block re-read 2026-10-29, the demand re-read of PT week 10-22..10-28, and the "Decisions taken" / "Open items" ledgers), `docs/reference/architecture-notes.md`, `docs/overnight/ledger.md` (1,356 headings on the mount; the 11-02 nightly spliced to 1,358 on origin), `docs/overnight/metrics-latest.json` (the 2026-11-02 ~1:03 AM PT overnight pass, plus the 11-01 pass for the day-earlier reading), the 2026-11-01 monthly strategy & traction review, and first-hand file-tool + shell scans over the connected repo (`git`, `grep`, `wc`, `ls`) at ~03:10 AM PT.
**Scope:** A single consolidated, themed view of open work — the numbered known-issue slots (`#0–#225`), the go-live framing, the prioritized actions, the overnight operational queue, and the in-code marker inventory — with suggested severity, effort, and a recommended sequence.
**Prior report:** `PROJECT_HEALTH_2026-10-26.md` (7 days ago). This regeneration mirrors its structure. `_2026-10-19.md` … `_2026-05-22.md` (twenty-five earlier reports) also live in `docs/health/`.

> **Biggest change since 2026-10-26 — the big-build momentum continued but SHIFTED from pricing/parity plumbing to collector-utility features and cross-collection parity, and the two long-standing credential residues finally CLOSED.** The week shipped **532 commits since 10-26** (down from last week's record 899, still a heavy week), again almost all interactive Cowork / Claude Code — the autonomous pass stayed green-and-idle every night. The dominant workstreams were (1) **a new collector-utility layer**: the user-to-user **Trade Room** (signing live since 10-31, kill switch `RPC_TRADE_ROOM_EXECUTE`), the **"Top Shot This" trade-in finder** (cheapest next pack per player), **follow-a-player across every collection** (incl. Pinnacle characters at `/character/`) and **player checklists** (owned vs missing, cost to complete); (2) **All Day / Candy / Pinnacle parity** — "The RPC Index for All Day" (`/insights/allday-market`), serial-premiums, Hot Floors, rookie/squeeze boards, Candy ESPN MLB stats + live-listings market, Pinnacle character pages + Hot Floors; and (3) **a trophy/art/correctness arc** — the UFC Strike art IPFS→Supabase-Storage mirror (#224), the Pack Sniper Atlas failover while Studio's index froze (#218), the offer-not-in-Atlas false claim (#220), the lock-lane rework (#222), the parallel-label fix (#216), and the intra-wallet `moment_id` collision sweep (#223). The register grew **12 slots (#214–#225)** and **closed +13 (201 → 214)**; open+partial moved **10 → 9**. Last week's whole open/partial list is settled: **#202** (Panini LOW ask-cap), **#193** (Pinnacle HIGH tier), **#198** (All Day V1 re-verify), **#22** (Dapper credential) and **#212** (LiveToken credential) all CLOSED. The current open set is small and mostly measurement/decision work, not fire: **#213** (STALE cap re-opened — low-serial sales, re-read ~11-05), **#221** (wmc player-name spelling variants — user-visible half fixed, alias/crosswalk half open), **#223** (one human SQL-editor paste to quarantine 164 cross-collection acquisition rows), **#225** (UFC video still gateway-bound — a Trevor infra-cost decision).

> **Overnight reality — GREEN and idle by design, again, every night this week.** Tonight's pass (2026-11-02 ~1:03 AM PT, genuine overnight, push-capable via the laptop-VM route, no `FREEZE`) shipped **0**, reverted **0**, logged a quiet green night: the whole recent surface (UFC art mirror, #221/#222/#223/#142, the packs Chase view) is **hot**, so nothing clean-safe + non-hot + independently verifiable was open to ship. Health GREEN across security, structure, pipelines, trust and the accuracy gate. The 11-01 pass fired off-hours (laptop closed overnight) and was monitor-mode; it also shipped 0. The week's shipping was all interactive Cowork / Claude Code sessions.

> **Traction reality — demand up sharply, authed activation still flat.** The monthly review (2026-11-01, 30-day) reads **WAU 4** (internal-excluded, up off ~2), **MAU 15**, **38 accounts** (33 with usernames), **5 new accounts in 30 d**, **1 email subscriber**, and the standout: **outbound buy-link clicks 222 in 30 d — up ~18× month-over-month**. The weekly demand read (PT week 10-22..10-28, `scripts/demand-read.sql`) shows the activation wall up close: 63 human browsers / 98 visits, **2 external signed-in users, 0 signups**, 38 wallet-pastes (4 by browsers), 9 share views — and it is **confounded by the Dapper outage** (10-27 → late 10-28, two days with no live market to look at), so the signed-in drop is not yet a trend. ⚠ The user gate is **100 WAU** and **outreach is off** (Trevor, 10-14). Supply of eyeballs is up (insights/collection views ~doubled); turning them into returning authed users is the bottleneck the roadmap names. Next weekly re-read ~**11-05**.

> **Accuracy gate — read the series, not the leg; Top Shot's ~45 % is the by-design 1.8.2 label correction.** File-blessed weekly-mean legs (`rpc_trust_health_history`, roadmap-status 10-29 block, wk 10-26 partial 13–14 legs): **Top Shot (M1) 45.0 %** (🔴 under its 50 % bar *by decision* — FMV 1.8.2 `gateMediumToRecentSale` requires a usable sale within 30 days), **All Day (M2) 27.8 %** (🔴 short of 30 %, edging up ~0.4/wk), Pinnacle **33.3 %** (own leg, never averaged), Candy **58.2 %** (a relabel on a frozen market, unscored; the honest fall is expected from ~11-10), Panini **45.9 %** (flat since the 1.3.x re-grade), Golazos **0.2 %** (newest sale left the 30-day window — honest), UFC **0.0 %** (closed-market sentinel). Flat across the Dapper outage (confidence is graded on the 30/90-day window, so a two-day stop does not show in the share — it shows in the backtests). The live Top Shot HIGH+MEDIUM share reads ~45 % of 14,609 canonical editions (monthly review); ~half of Top Shot is still ASK_ONLY/LOW — the honest-coverage hole the roadmap names as the on-thesis pricing work.

> **Cost / storage — ~44.3 GB tonight, swinging on the pg_net sawtooth, up ~2 GB week-over-week on legitimate Panini growth.** Live reads: DB **44,349 MB (~44.3 GB)** at the 11-02 1:03 AM pass, **42,335 MB** at the 11-01 morning pass — a ±~1.3–2 GB swing as `net._http_response` fills and self-prunes (the documented sawtooth). The durable growth is Panini: `panini_card_serials` ~8.5 → **~9.27 GB**, Panini editions 39,524 → **40,153 (+629)**. Compute stays **LARGE** (resized 09-20). ⚠ The ~4.2 GB June DB-size baseline doc remains **badly stale** — the real operating baseline is ~42–44 GB; resetting it so it stops reading as a ~10× regression is still an open housekeeping item. The 11-02 pass flagged the +2 GB night as a WATCH (confirm `_http_response` comes back down within a day).

> **Platform context.** Top Shot's public REST API stays dead; the Atlas backend is the feed and answers a Cloudflare 403 on some lanes by design (self-healing). **Flowty was RETIRED 10-30** — its API went dark 10-27 ~9:20 PM PT, and the three listing-cache lanes, `/api/listing-cache`, `golazos-sniper-feed`, their schedulers, the Flowty rows and `flowty-proxy` (now a 410 tombstone) are gone (runbook: `docs/operations/flowty-retirement-runbook.md`); All Day / Golazos asks already came from Dapper's own storefronts, so nothing priced broke. **A separate Dapper Studio outage** (10-27 → late 10-28) closed the All Day / Pinnacle markets for ~two days and froze the sealed-pack index (#218). NFL All Day secondary-market only. UFC Strike Flow market frozen (0 sales; honestly labelled; its video art remains gateway-bound, #225). **Candy/Solana is LIVE but its market has been frozen since 2026-10-11** — `candy_sales_stale_hours` is under threshold only because the threshold was widened to a re-verify clock (~11-27); it is the lone honest downstream symptom of a real dead market (#58). Panini = WC Prizm + basketball plane (`PANINI_PUBLIC = true`); the collector-walk runs on Trevor's laptop and went briefly silent 10-29 → 11-02 when the box was closed overnight (benign — resumed; `panini_fmv_stale_hours` back to 0).

> This is a snapshot. `CLAUDE.md` + `docs/reference/known-issues.md` are the source of truth for project memory; `docs/overnight/ledger.md` for what shipped; `docs/strategy/roadmap-2026-10-17.md` for the plan. This doc reorganizes them for triage. **Severity and effort tags throughout are suggestions, not gospel.**

> **Report location stays clean.** All reports (this one included) live in `docs/health/`; the repo root holds none (verified this run).

---

## 1. At a glance

| Bucket | Count | Notes |
|---|---|---|
| Known-issue slots tracked | **#0–#225** | Register STATUS INDEX: **223 numbered items — 4 open · 5 partial · 214 closed**. 12 new slots (#214–#225) since last week. See §9. |
| Known issues — resolved/closed since last week | **+13 net** | Closed count rose 201 → 214. Moved off the open/partial list: #202, #193, #198, #22, #212 (all closed) — see §6 / §9. |
| Known issues — open / partial | **9** | **4 open** (#213, #221, #223, #225) + **5 partial** (#66, #208, #209, #210, #218). Down from 10 last week. — §3 / §9 |
| Known issues — 🚨 live trust breach | **0** | `topshot_impossible_parallel_serials` 0; `v_fmv_sanity_flags` 0; **0 breaches / 40 legs ok** (`candy_sales_stale_hours` now under its widened ~11-27 re-verify clock, not a breach). — §2.4 |
| Known issues — needs Trevor, operator | **few** | **#223** the SQL-editor quarantine paste (164 rows, $1,673.51 invented spend); **#225** the UFC-video mirror infra decision; **#66** external links (gated on the accuracy gate); **#58** OpenSea key (candy re-verify ~11-27); **#114** dashboard roster drift (16 sources vs 11 published); C2 postal address; S1/S3/S6 console tokens. — §2.6 |
| Known issues — carried shelved | **~1** | **#58** OpenSea key — the 3 candy-opensea lanes stay unscheduled; only a Trevor-set key would resume the Candy book, if ever wanted (re-verify clock ~11-27). |
| Known issues — removed from the tree by decision | 3 | #1 Cart, #3 Trade Hub, #3b Gifting — DELETED (read-only pivot). Verified still absent this run. |
| Go-live plan | **M1–M11 + B1–B5** | `docs/strategy/go-live-2026-09.md`. Accuracy gate: Top Shot met (series, by-design ~45 % leg), All Day short. Demand is the binding bar. — §2.1 |
| Commits since last report | **532** | `git log --since 2026-10-26` on the connected mount. Authors: Claude 423, Claude (Cowork) 47, Trevor 40, monitor/nightly bots ~22. Mount HEAD `35f35c58b` 2026-11-01 10:50 PT (Claude); mount trails origin (`903027572`, tonight's 11-02 nightly). |
| Accuracy gate (headline metric) | **Per-collection, weekly-mean legs** | Top Shot **45.0 %** (by-design 1.8.2 re-grade; read as a series), All Day **27.8 %** (NOT MET), Pinnacle 33.3, Candy 58.2 (relabel, frozen), Panini 45.9, Golazos 0.2, UFC 0.0 (sentinel). — §2.1/§2.3 |
| Demand (the critical-path number) | **thin; buy-link clicks ↑18× MoM** | 30-day: WAU 4, MAU 15, 38 accounts, outbound buy-link clicks **222 (↑~18×)**, 1 email sub. Weekly (10-22..10-28, Dapper-confounded): 2 signed-in, 0 signups. Gate: **100+ WAU**; **no outreach** (10-14). — §2.1 |
| Open overnight operational items | **standing queue** | #58 OpenSea key (candy re-verify ~11-27); #114 dashboard roster drift (16 vs 11); `topshot-active-listings-ingest` egress-block watch (backstop fix shipped, ages out); `panini-ingest-enum` cadence-threshold recalibration (optional). — §2.6 |
| Net-new structural workstream | 2 live + utility layer | Candy/Solana LIVE (thin, market frozen) + Panini (WC Prizm + basketball, collector-walk live); plus the new collector-utility layer (Trade Room live-signing, trade-in finder, follows, checklists) and a paused Rewards economy. — §2.8 |
| Prioritized next actions | **canonical** | `roadmap-2026-10-17.md` (accuracy-is-the-gate) + `go-live-2026-09.md`. Gate: **100+ WAU**, no outreach, no infra spend pre-revenue. See §4. |
| In-code TODO markers | **0 actionable** | Measured this run (`git ls-files` + `grep`): **6** match lines, all narrative/false-positive (incl. the `$X,XXX.XX` literal). — §5 |
| Test / DB-invariant pins | **287 `supabase/tests/*.sql` files** | +10 vs last week's 277 (measured this run, `ls`). |
| CI jobs (ci.yml) | **21** | Measured this run under `jobs:` — unchanged from last week (same 21). See §8. |
| Public `/insights` surfaces | **38** | Measured this run: 38 `app/insights/*/page.tsx` dirs (+5 vs 33). |
| Active revenue-blocking items | 0 | By decision — monetization tabled until 100+ WAU. |

**Health read:** Another heavy, clean shipping week — 532 commits, all interactive, the autonomous pass green-and-idle every night. The register's open work *shrank* (10 → 9 open+partial), and the shape is reassuring: the two credential residues that topped last week's P0/P1 list (**#22** Dapper, **#212** LiveToken) both closed when Trevor signed out 10-26, and all three pricing/parity items last week's report tracked (**#202**, **#193**, **#198**) closed on their scheduled proofs. The week's new slots are almost all shipped-and-closed in the same window (#214/#215/#216/#217/#219/#220/#222/#224), leaving only measurement/decision work open. The concentrated risk is unchanged in shape: **(1) demand** — external WAU is a handful against a 100-WAU gate with outreach off, though buy-link clicks surged ~18× MoM and the drop-off is now clearly at the authed step, not acquisition; **(2) two founder-only follow-throughs** — the #223 SQL-editor quarantine paste (164 rows / $1,673.51 of invented spend, blocked only by Supabase's confirmation prompt) and the #225 UFC-video infra-cost decision; and **(3)** a short, bounded pricing-accuracy tail (#208/#209/#210/#213) with clear falsifiers and dated re-reads. Live trust metrics are fully clean (0 impossible serials, 0 FMV sanity flags, 0 arm breaches). All Day remains the one published collection short of its accuracy bar.

### Themes

| Theme | Items |
|---|---|
| **Launch / activation (the whole critical path)** | Public + self-serve. Demand up (buy-link clicks ↑18× MoM, views ~2×) but authed activation flat (WAU 4). Gate **100+ WAU**, **outreach off** (10-14). The problem is now *activation*, not acquisition. (§2.1) |
| **Collector-utility layer (the week's big build)** | Trade Room (user-to-user, signing live since 10-31), "Top Shot This" trade-in finder, follow-a-player across collections (+Pinnacle `/character/`), player checklists — all read-only / no custody beyond signed trades (§2.8) |
| **All Day / Candy / Pinnacle parity** | "The RPC Index for All Day" (`/insights/allday-market`), serial-premiums, Hot Floors, rookie/squeeze boards; Candy ESPN MLB stats + live-listings market + pack EV; Pinnacle character pages + Hot Floors; packs "Chase left" view (§2.3/§2.8) |
| **Trophy / art / correctness arc** | UFC art IPFS→Supabase mirror (#224), Pack Sniper Atlas failover (#218), offer-not-in-Atlas false claim (#220), lock-lane rework (#222), parallel-label fix (#216), intra-wallet `moment_id` collision sweep (#223), fmvBasis capped marker (#215) (§2.3/§2.4) |
| **Live trust breach CLEAR** | `topshot_impossible_parallel_serials` 0; `v_fmv_sanity_flags` 0; **0 arm breaches / 40 legs** (§2.4) |
| Credential residues — now CLOSED | #22 Dapper session + #212 LiveToken session both RESOLVED 10-26 (Trevor signed out on all devices; both leaked values past session lifetime / server-side sessions ended) (§2.4) |
| Pricing-tier caps (carried partials) | #208 ASK_ONLY (All Day + Golazos), #209 STALE (Top Shot + All Day), #210 thin-sale haircut depth floor — each a partial with a weekly/measurement tail (§2.3) |
| STALE low-serial cap (re-opened) | #213 — the #209 STALE cap ignores sales at serial ≤ 25; a premium-serial-aware rule is measured but not shipped (doesn't win every cell); re-read ~11-05 after a full All Day week post-Dapper (§2.3) |
| wmc player-name variants (open) | #221 — `wallet_moments_cache.player_name` disagrees with the catalog on 9,842 TS / 2,286 AD rows; the user-visible collection filter was fixed 11-01 (folds via `_norm_player`); true aliases + canonical catalog spelling via the crosswalk stay open (§2.3) |
| Cross-collection acquisition collision (open, operator) | #223 — #142's `moment_id` collision happens inside one wallet; all session-applicable fixes shipped, one human SQL-editor paste remains (quarantine 164 rows, $1,673.51 invented spend) (§2.6) |
| UFC video art (open, Trevor decision) | #225 — UFC video still needs a public IPFS gateway; poster now renders from the #224 mirror so the trophy displays, hover-to-play fails silently; a ~10–14 GB + per-play-egress infra-cost call (§2.6) |
| Instrument darkness | #34 Sentry dark (beacon is detector; 0 client errors / 24 h); #114 dashboards ported 10-20 but a roster-drift note (16 sources vs 11 published) is queued (§2.5) |
| Security | scans clean; trust breach clear; both credential residues closed; #60 (can't revoke anon from net/cron schemas) carried, needs Supabase support (§2.4) |
| Product simplification — READ-ONLY pivot | Cart / Trade Hub / Gifting **DELETED** — verified still absent. (The new Trade Room is no-custody, signed, user-to-user — not the old Trade Hub.) (§2.9) |
| SEO | #66 — code items done; 10-28 Search Console re-read done (49.4K indexed, up from 31.8K); external links remain Trevor's, gated on the accuracy gate (§2.3) |
| Tech debt / refactor | Monoliths re-measured, slightly up: DashboardClient **3,058** / SniperClient **2,228** / CollectionAnalyticsClient **2,037** / CollectionTabClient **1,664** / MarketClient **1,383** (§3) |
| DB-size baseline | The June ~4.2 GB baseline doc is still stale; operating ~42–44 GB on the pg_net sawtooth + Panini growth. Reset it (§2.6) |
| Deferred hardening (intentional) | Public INSERT-policy tables; `owner_key`→`user_id`; Golazos `highest_offer` gap (settled: no offer source); `INGEST_SECRET_TOKEN` rotation owed; `buildTopshotPoolPayload` fabricated-divisor (latent, no live caller) |

---

## 2. Critical path — start here

Go-live is **operationally done** (public + self-serve). The forward plan is **`docs/strategy/roadmap-2026-10-17.md`** (canonical; accuracy is the GATE, headline metric is the HIGH/MEDIUM confidence share read as a series) plus **`docs/strategy/go-live-2026-09.md`** (what "through the gate" means in numbers). The binding user bar is **100+ WAU** (raised from 50 on 09-25), and **outreach is off** (Trevor, 10-14).

### 2.1 Launch + activation — accuracy near its bars, demand arriving but not activating — `Severity: High · Effort: Medium (built + measured, no traffic by directive)`

Read-only tabs are anonymous for the 5 published Flow collections (+Candy overview, +Panini); cost-basis/P&L, saved wallets, watchlist, `/dashboard/*`, the Trade Room, and every mutation stay behind sign-in.

- **Traction, 30-day monthly review (2026-11-01):** WAU **4** (internal-excluded, up off ~2), MAU **15**, **38 accounts** (33 usernames), **5 new accounts / 30 d** (no new early-access-form signup since Sept 8), **1 email subscriber**, real concierge convos **28** (down, mostly less founder testing), and the standout — **outbound buy-link clicks 222 / 30 d, up ~18× MoM**.
- **Funnel (30 d vs prior 30 d):** insights_view 22,920 → 52,095 (+127 %), collection_view 33,843 → 63,623 (+88 %), home_view 1,950 → 5,312 (+172 %), **wallet_paste 56 → 69 (+23 %)**, share_view 85 → 132, signin_click 13 → 10 (flat/down). Entry is almost entirely anonymous on `/insights/*` and collection pages; the **cliff is at the authed step** (tens of thousands of views → 69 wallet-pastes → 10 sign-in clicks → ~0 form signups). Weigh the ratios and human-verified clicks, not raw view counts (a large share is crawler/bot).
- **Weekly demand read (PT week 10-22..10-28, `scripts/demand-read.sql`):** 63 human browsers / 98 visits, **2 external signed-in users, 0 signups**, 38 wallet-pastes (4 browsers), 9 share views. ⚠ **Confounded by the Dapper outage** (10-27 → late 10-28); read the next week (~11-05) before calling the signed-in drop real.
- **Accuracy (weekly-mean legs, roadmap-status 10-29 block, wk 10-26 partial):** **M1 Top Shot 45.0 %** (under 50 % *by decision* — the 1.8.2 MEDIUM re-grade), **M2 All Day 27.8 % (≥ 30 % — NOT MET, edging up ~0.4/wk)**, Pinnacle 33.3, Candy 58.2 (relabel, frozen), Panini 45.9, Golazos 0.2, UFC 0.0 (sentinel). ⚠ Read the series, not the leg. Flat across the Dapper outage — confidence is graded on the 30/90-day window.

The critical-path action is unchanged by directive: with outreach off (10-14) and the gate at 100 WAU, keep accuracy beating the incumbents (the gate) and close the activation drop-off. The monthly review's clearest lever is **converting the anonymous traffic already arriving** — a no-login, high-intent anon → wallet-paste → "here's your squeeze / EV / what to chase" path tuned on the two growing actions (wallet_paste, outbound clicks). Demand is still the single most important line in the report, and it is now an *activation* problem more than an acquisition one.

### 2.2 Public intelligence surfaces — 38 public — `Severity: n/a (shipped) · context`

All 38 built surface dirs in `app/insights/` are public (measured this run: 38 `page.tsx`, +5 vs last week — the All Day / parity boards and a per-collection squeeze split, e.g. `/insights/allday-squeeze`, `/insights/allday-set-squeeze`, each with its own URL + metadata so a crawler/unfurler sees the right collection, #216/the 10-27 architecture note). Carried honesty risks `#50` (`/insights/pack-reality` ranker) and `#33`-class (ISR bakes a failed read into the `revalidate` window) remain as standing design considerations.

### 2.3 Data-intelligence — parity build + the FMV-cap tail — `Severity: Medium (correctness) · Effort: mixed`

**FMV HIGH/MEDIUM counts (11-02 overnight pass):** Panini 18,022, NBA Top Shot 6,578, NFL All Day 1,628, Pinnacle 909, Candy 68, Golazos 1, UFC 0. (Pinnacle HIGH+MED has slid two passes — 996 → 955 → 909 — as sales age out of the window; FMV is fresh with 0 sanity flags, so this is confidence-bucket churn, not a read failure.)

**Shipped / landed since last week:**

- **Collector-utility layer.** The user-to-user **Trade Room** went to live signing 10-31 (`lib/trade-room/execute.ts`, kill switch `RPC_TRADE_ROOM_EXECUTE`; no custody). The **"Top Shot This" trade-in finder** (cheapest next pack per player, concierge `get_trade_in`, counterparty email notices), **follow-a-player across every collection** (incl. Pinnacle characters at `/character/`), and **player checklists** (owned vs missing, cost to complete) all shipped.
- **All Day / Candy / Pinnacle parity.** "The RPC Index for All Day" (`/insights/allday-market`), serial-premiums, Sniper/Hot Floors/offers/squeeze/rookie parity; Candy ESPN MLB season stats on player pages + live-listings market + pack EV; Pinnacle character pages + Hot Floors; the packs **"Chase left"** view (sealed high-tier density vs launch).
- **#224 — UFC Strike art no longer depends on a public IPFS gateway (RESOLVED 11-01).** `/api/public/ipfs-thumb` now reads a durable Supabase Storage mirror (`ipfs-thumbs`) first and writes back; a daily workflow backfilled all 582 UFC CIDs × 4 widths. Found on the trophy case (Leon Edwards slab broken on page + share card; prod logs `dapperlabs=403 pinata=abort_timeout ipfs.io=429`).
- **#218 — Pack Sniper Atlas failover (PARTLY RESOLVED 10-30).** Dapper Studio's sealed-pack index froze ~10-29 8 AM PT and the Sniper kept saying "Live asks" over a frozen book (no read failed — the independent witness was the chain's `pack_purchases`). Failover shipped.
- **#220 — a Top Shot bid Top Shot doesn't show is a false claim (RESOLVED 10-31).** A chain-open $180 offer never appeared in Atlas; since a collector can only accept through Top Shot's UI, publishing it was false. The board now reads Atlas's view.
- **#222 — wmc `is_locked` writer discipline + lock state followed from chain (RESOLVED 11-01).** Every writer named, lock state now followed from `topshot_lock_events_tick`.
- **#216 — parallel labels (RESOLVED 10-29).** Public Top Shot boards listed a parallel (e.g. a Rippled /4000) with its set name alone, so it read as the standard /4000. Fixed; the boards now distinguish the editions.
- **#215 — fmvBasis capped-price marker (RESOLVED 10-30).** Every `fmvBasis` caller that can meet a capped price now carries the flag.

**New / open:**

- **`#213` — the #209 STALE cap ignores low-serial sales (OPEN, RE-OPENED 10-29, measurement).** `fmv_snapshots_cap_stale_to_last_sale()` reads only `serial_number > 25`, so on a small edition a newer, lower low-serial sale can sit under an uncapped price (All Day Chris Jones /30: newest sale serial #9 at $69 vs a published STALE $520). A candidate "cap at the last non-premium-serial sale" rule is measured (WAPE improves in every cell) but **not shipped** — it does not win every hit-rate cell and n is small (13–35 moved sales vs a ≥ 60 bar). **Re-read ~11-05**, after All Day trades a full week post-Dapper reopening; ship the rule if it wins every cell then, or decide with Trevor. Top Shot needs its own serial-aware arm.
- **`#221` — wmc player-name spelling variants (OPEN, NEW 10-31; user-visible half fixed).** `wallet_moments_cache.player_name` is a denormalised copy that disagrees with the catalog on **9,842 Top Shot rows** (33 spellings) and **2,286 All Day rows** (60) — "Luka Doncic"/"Luka Dončić", "Team Moment" → 30 franchises. The user-visible collection player filter was fixed 11-01 (`get_wallet_moments_with_fmv` now matches through `_norm_player`; both spellings return all 593 Moments on the largest TS wallet). **Still open:** true aliases ("Rob"/"Robert Dillingham") and making the catalog spelling canonical through the player-identity crosswalk; per-player aggregates key on `editions.player_name` until then.
- **`#223` — #142's `moment_id` collision happens inside one wallet (OPEN, NEW 11-01; one human step remains).** One Flow wallet holds Top Shot, All Day and UFC moments whose ids collide, so a wallet-scoped read/write is not scoped (the binder showed All Day 10565124 as "Paid $65" — Top Shot's price). **Everything a session can apply is shipped** (binder sort scoped, 9 wallet-only code sites scoped, guard tightened, mis-tagged purchases re-tagged). **Open — Trevor, SQL editor:** `docs/pending/142-quarantine-run-in-sql-editor.sql` moves **164** `sales_backfill` rows priced from an All Day / UFC sale the wallet never made (**$1,673.51** of invented spend) into a quarantine table and drops the now-uncalled 2-arg function — held only by Supabase's confirmation prompt, which never reaches a cloud session.
- **`#225` — UFC Strike video still needs a public IPFS gateway (OPEN, NEW 11-01; a Trevor decision).** All 617 UFC editions carry `video_url` on `ipfs.io`; today no gateway reliably answers. The poster now comes from the #224 mirror, so the trophy **displays as its image**; hover-to-play fails silently. Mirroring video is ~617 × 16–23 MB ≈ 10–14 GB storage + per-play Supabase egress — an infra-cost call under "no infra spend pre-revenue." Options: (a) poster only; (b) mirror only pinned trophies (bounded); (c) full mirror. Re-derive sizes before deciding.
- **`#208 / #209 / #210` — pricing-cap partials (carried).** Price halves are done and backtested; the tails are #208's weekly hold (All Day + Golazos ASK_ONLY, 1.80 → 1.00), #209's basis-line, and #210's remaining haircut sub-classes (0-sale cells 0.55 → 0.75).
- **`#66` — SEO (PARTIAL, needs Trevor):** every code item done; the **10-28 Search Console re-read is DONE** (49.4K indexed, up from 31.8K on 10-03; 28 d 60 clicks / 2.15K impressions / pos 12.5; the 46 `/profile/0x…` 404 fossils now 308 to `/share/<wallet>`). What remains is external links, held by the accuracy gate (Trevor).

### 2.4 Security, confidentiality + test infrastructure — `Severity: Medium (clean scans; 0 live breaches) · Effort: mostly landed`

- **Security scans clean** (invariants, anon-write holes, rls-off-base-tables, secdef-anon all `[]` / 0 rows, via `rpc_ops_snapshot.security`, both overnight passes this window). RLS: 0 public base tables with RLS off, 0 anon write-grants. (An `rls_off_base_table:_wmc_league_backfill_cursor` smoke-test row was stale — the cursor table was dropped 10-31; current security clean.)
- **Live trust breach clear.** `topshot_impossible_parallel_serials` 0; `v_fmv_sanity_flags` **0**; **0 arm breaches / 40 legs ok** (11-02 pass). `candy_sales_stale_hours` 509.7 is now *under* its widened re-verify clock (1114.9, ~11-27) rather than a breach; `edition_integrity_flags` 22 (threshold 250), `panini_coverage_pct_drop` 5.9 (15), `panini_fmv_stale_hours` 0 (back to 0 after the laptop runner resumed), `trust_precompute_max_age_hours` 5.29 (13) — all ok.
- **`#22` — Dapper credential residue — RESOLVED 10-26.** Trevor signed out of Dapper on his laptop and phone; Dapper (Google sign-in) has no sign-out-all-devices lever, and the leaked token is an April RS256 login token long past any session lifetime (GitHub had purged the commit 10-20). The PII in its payload stays treated as exposed; nothing further is actionable.
- **`#212` — LiveToken credential residue — RESOLVED 10-26.** Trevor signed out of LiveToken on laptop and phone; the leaked values are a server-side session (not a self-expiring JWT), so the sign-out ends it. (`no-credential-literals-in-tracked-files.test.ts` bans the shape; the current file is redacted.)
- **`#60` (carried):** Postgres cannot revoke `anon`/`authenticated` from the `net`/`cron` schemas; real fix needs Supabase support.
- **DB-invariant SQL layer: 287 `supabase/tests/*.sql` files** (+10, measured this run). CI is **21 jobs** in `ci.yml` (unchanged). **Never lower thresholds to green a build.**

### 2.5 Automation / asset hygiene — `Severity: Low–Medium · Effort: ongoing`

⚠ **`#34` — Sentry dark; no-spend DECIDED** — the `window.onerror`/rejection beacon → `usage_events.client_error` is the detector; this window reads **0 client errors / 24 h**. ⭐ **`#114` dashboards** were ported to claude.ai artifacts 10-20, but a **roster-drift note is queued** (daytime-monitor inbox 11-02T0713Z): `docs/cowork-skills/` holds **16** dashboard HTML sources while the #114 map and the monitor's roster record **11** published claude.ai artifacts — the 5 extras (`rpc-insights-health`, `rpc-pipeline-reliability`, `rpc-rookie-supply-ladder`, `rpc-security-drift`, `rpc-trade-in-value-finder`) have no published URL recorded. Needs a decision (publish + register, or document as excluded) plus a monitor-prompt roster edit (§2.6). ⭐ **`#76`** (site-availability alarm) stays resolved. The true-mobile QA instrument (`scripts/qa/mobile-sweep.mjs`, real Chromium at 390/320 px) remains the only real mobile instrument; the week added extensive 320 px hardening.

### 2.6 Overnight operational queue — `Severity: Low–High (mixed) · Effort: mixed`

Health scans GREEN (0 stalled pipelines on the 11-02 pass; `panini-ingest-enum` resumed). Open items for Trevor / operator / Claude Code:

| Item | Issue | Severity | Notes |
|---|---|---|---|
| **#223 — cross-collection acquisition quarantine** | 164 `sales_backfill` rows priced from an All Day/UFC sale the wallet never made ($1,673.51 invented spend); drop the uncalled 2-arg function. | **P1 (operator)** | Run `docs/pending/142-quarantine-run-in-sql-editor.sql` in the Supabase SQL editor (held by the confirmation prompt no cloud session can answer). |
| **#225 — UFC video mirror** | UFC video still gateway-bound; poster renders, hover-to-play fails silently. | **Med (Trevor decision)** | ~10–14 GB storage + per-play egress. Choose poster-only / pinned-only / full mirror; re-derive sizes. |
| **#114 — dashboard roster drift** | 16 dashboard HTML sources vs 11 published claude.ai artifacts; 5 extras unrecorded. | Low–Med (operator) | Decide publish-or-exclude for the 5; update the #114 map + the daytime-monitor §1b roster. |
| **#58 OpenSea key** | 3 candy-opensea lanes unscheduled; only a Trevor-set key resumes the Candy book. | Low (optional) | Candy re-verify clock ~11-27; low pressure. |
| **S1 / S3 / S6 + C2** | console token rotation (cron-job.org, GHA, Vercel) + CAN-SPAM postal address (`RPC_SENDER_POSTAL_ADDRESS`). | Med (operator) | Do before marketing starts; digests stay flag-off until C2 exists. |
| **`topshot-active-listings-ingest` egress block** | medium 3/11 (27.3 %) egress-blocked over 3 calendar days on a low-volume lane. | watch | Backstop-attribution fix shipped 11-01 (`25bdf5a1e`); pooled 3-day alert ages out on its own. |
| **`panini-ingest-enum` cadence threshold** | 738-min silence threshold fires `info` on a weekend-quiet enum (laptop runner closed). | P3 (optional) | Relax/annotate so a quiet enum stops surfacing near-threshold info. |
| **DB-size baseline doc** | The June ~4.2 GB baseline reads as a ~10× regression against ~42–44 GB operating. | Low (housekeeping) | Reset it; keep the `net._http_response` sawtooth + Panini growth on watch. |

### 2.7 Pack EV / pack-viz — `Severity: Low–Medium (correctness, mostly clean) · Effort: mostly landed`

Pack-EV surfaces label rows for packs nobody can buy and disclose AllDay/Golazos EV as an original-supply model; Candy leads with Typical-Pull median; the new packs **"Chase left"** view shows sealed high-tier density vs launch. During the Dapper Studio index freeze (#218), the Sniper's Atlas failover kept pack asks honest rather than publishing a frozen book as "Live asks." Pack-EV freshness holds (pack_ev fresh through the window; the designed per-page Atlas 403 re-ask drives the `topshot-pack-supply-atlas` fail count, not a real outage).

### 2.8 Chain foundation — Candy LIVE (frozen market), Panini walked + parity-built, utility layer added, Rewards paused — `Severity: Low (shipped) · Effort: landed`

- **Candy / Solana — LIVE, THIN, market FROZEN since 10-11:** `CANDY_MLB_PUBLIC = true` (verified this run). FMV stays green off existing data; `candy_sales_stale_hours` is the honest downstream symptom (re-verify clock ~11-27). The week added ESPN MLB season stats on player pages, a live-listings market and pack EV.
- **Panini — the WC Prizm + basketball plane** (`PANINI_PUBLIC = true`, verified this run). Collector-walk keeps adding editions (**40,153**, +629 week-over-week; `panini_card_serials` ~9.27 GB, the main durable DB-size growth driver). The walk runs on Trevor's laptop and went briefly silent 10-29 → 11-02 when the box was closed overnight (benign — resumed). This week added cross-collection team-map card placement, the #202 LOW-price ask-cap, and branded OG.
- **Collector-utility layer (new):** the no-custody user-to-user Trade Room (signing live since 10-31, `RPC_TRADE_ROOM_EXECUTE`), the trade-in finder, follow-a-player, and player checklists — a genuine utility layer around Top Shot's transactions, not a competitor to them.
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
| — | **Traffic / WAU.** External WAU 4 against a 100-WAU gate; buy-link clicks ↑18× MoM, views ~2×; the drop-off is now at the authed step. **No outreach** (10-14). | **High** | Medium (assets built, traffic off by directive) |
| — | **Go-live bars.** Accuracy gate: Top Shot MET (series, by-design ~45 % leg), All Day short. Demand is the binding bar. | High | Mixed |

### Data completeness / accuracy / pricing

| # | Issue | Severity | Effort |
|---|---|---|---|
| 213 | STALE cap reads only serial > 25, so a newer low-serial sale can sit under an uncapped price. Premium-serial rule measured, not shipped. Re-read ~11-05. | Low–Med (open) | Measurement + cap widen |
| 221 | `wmc.player_name` disagrees with the catalog (9,842 TS / 2,286 AD rows); user-visible filter fixed; aliases + canonical catalog spelling via crosswalk open. | Med (open) | Crosswalk + reconciler |
| 208 | All Day + Golazos ASK_ONLY price capped at recent sales (1.80 → 1.00); weekly hold open. | Low–Med (partial) | Backtest tail |
| 209 | Top Shot + All Day STALE price capped at last market sale; basis-line half Trevor's. | Low–Med (partial) | Mostly landed |
| 210 | Thin-sale haircut depth floor was absent (0-sale cells took the deepest cut); now 0.75, remaining sub-classes open. | Low–Med (partial) | Measurement tail |
| 66 | Zero external links (gated on the accuracy gate); code items done; 10-28 Search Console re-read done. | Med | Off-platform (not code) |

### Operator-owned / Trevor decisions

| # | Issue | Severity | Effort |
|---|---|---|---|
| 223 | Cross-collection acquisition quarantine — 164 rows / $1,673.51 invented spend; drop the uncalled 2-arg function. | **P1 (operator)** | One SQL-editor paste |
| 225 | UFC Strike video still gateway-bound; a ~10–14 GB + egress infra-cost decision. | Med (Trevor) | Decision + optional mirror |

### Instruments / darkness / operator

| # | Issue | Severity | Effort |
|---|---|---|---|
| 34 | Sentry dark (beacon is detector; 0 client errors / 24 h). | Med | Decided (no spend) |
| 60 | Cannot revoke anon/authenticated from net/cron schemas; needs Supabase support. | Low–Med | External |
| 114 | Dashboard roster drift — 16 sources vs 11 published artifacts; 5 extras unrecorded. | Low–Med | Decision + roster edit |
| 218 | Dapper Studio sealed-pack index froze; Pack Sniper Atlas failover shipped. | Low–Med (partial) | Mostly landed |

### Tech debt / refactor

| # | Issue | Severity | Effort |
|---|---|---|---|
| 14 / 10 | Monolith page refactor — re-measured this run: DashboardClient **3,058**, SniperClient **2,228**, CollectionAnalyticsClient **2,037**, CollectionTabClient **1,664**, MarketClient **1,383** (slightly up across the board). | Low–Medium | Large |

### Stalled / scaffolded + deferred hardening

- Cart / Trade Hub / Gifting — **DELETED, verified still absent** (the new Trade Room is a separate no-custody signed feature).
- Deferred hardening (intentional): `email_subscribers`/`outbound_clicks`/`portfolio_snapshots`/`support_conversations` public INSERT policies; `user_achievements`+`watchlist_items` still on `owner_key` (text); Golazos `highest_offer` gap SETTLED (no offer source — do NOT build the indexer); `sales-serial-backfill` substring-token check (latent dead code; `INGEST_SECRET_TOKEN` rotation owed); `buildTopshotPoolPayload` fabricated-divisor (latent, no live caller — exit when the pool lane revives, #65).

### Architecture notes worth tracking

- **Two "collection vocabulary" and two "confidence vocabulary" footguns** persist by design. Re-read `CLAUDE.md` before any new query.
- **Flowty is fully retired (10-30)** — `flowty-proxy` is a 410 tombstone; the listing-cache lanes are gone. All Day / Golazos / Pinnacle asks come from Dapper's own storefronts; Top Shot moment-page asks read `ts_listings`; `cached_listings_v2` holds 0 Top Shot rows.
- **Supabase compute is `LARGE`** (resized from SMALL 2026-09-20). Any pre-09-20 finding citing the SMALL-tier disk-IO floor (e.g. 22 MB/s) is stale — re-derive.
- **The June ~4.2 GB DB-size baseline doc is badly stale** — the DB now operates at ~42–44 GB on the pg_net sawtooth + Panini growth; reset the baseline.
- **FMV 1.8.2 tightened MEDIUM** (sale within 30 days) on 10-18 — Top Shot's HIGH/MED share reads ~45 % by design; a label correction, not a regression.
- **A server→client prop must be data, never a callback; a server component importing a VALUE (or calling a FUNCTION) from a `"use client"` module gets a stub** (new 10-25, recurred 10-26 as a called function — guard now bans camelCase function imports too); **a `"use client"` module must never reach `lib/supabase.ts`**; **a query-param toggle cannot change what a crawler sees — one collection, one URL** (10-27; drove the per-collection squeeze split); **an inline `<style>` reset must sit in `@layer base`** — all green in `tsc`/vitest/lint but only a real render / live request says so; see `architecture-notes.md`.
- **Eight caller sources** — including a laptop collector-walk runner and cron-job.org — are invisible to a repo grep. Enumerate all before calling any ingest dead.

---

## 4. Prioritized next actions — **canonical**

`CLAUDE.md`'s old list is replaced by **`docs/strategy/roadmap-2026-10-17.md`** (canonical; accuracy-is-the-gate) and **`docs/strategy/go-live-2026-09.md`**:

| Phase | Action | Status |
|---|---|---|
| Gate | **Accuracy is the GATE — HIGH/MEDIUM share must beat incumbents, read as a series.** | **Top Shot MET (series; ~45 % leg by design); All Day NOT MET (27.8 %) and edging up slowly; Pinnacle 33.3; Panini 45.9. ~half of Top Shot still ASK_ONLY/LOW — the on-thesis coverage hole.** |
| Go-live | **M1–M11 bars.** | Latency/beacon/mobile bars met in prior cycles; accuracy gate met for Top Shot, short for All Day; demand is the binding bar. |
| 1 | **Prove the product with real users — 100+ WAU; no outreach (10-14).** | **Open — the critical path. WAU 4; buy-link clicks ↑18× MoM but authed activation flat. Convert the traffic already arriving; hold outreach until the gate opens.** |
| 2 | Cost / latency / saturation levers. | **Stable — DB ~42–44 GB (Panini coverage + pg_net sawtooth), tier LARGE; reset the stale size baseline doc.** |
| 3 | Durable debt. | Heavy advance — collector-utility layer (Trade Room, trade-in finder, follows, checklists), All Day/Candy/Pinnacle parity, the trophy/art/correctness arc, both credential residues closed. |
| 4 | Chain two, readiness-gated. | Candy LIVE (thin, market frozen); Panini walked + parity-built; Rewards economy paused/dial-in. |

**Standing guardrails:** no paywall/Stripe until 100+ WAU; no infra spend pre-revenue; **no outreach** (10-14); **verify pages by rendered DOM, not HTTP 200**; **before gating/short-circuiting any route, enumerate EVERY caller** (eight sources).

**Housekeeping still outstanding:** run the #223 SQL-editor quarantine (164 rows / $1,673.51); decide #225 (UFC video mirror); resolve the #114 dashboard roster drift; S1/S3/S6 console tokens + C2 postal address; #58 OpenSea key (candy re-verify ~11-27); convert the arriving traffic (activation); and reset the stale DB-size baseline doc.

---

## 5. In-code TODO inventory

A first-hand scan over tracked non-docs source (`git ls-files` → `*.{ts,tsx,js,jsx,mjs,cjs,sql,toml,css}`, excluding `docs/`; `node_modules`/`.next`/`.git` are untracked-excluded) with `grep -nE '\b(TODO|FIXME|HACK|XXX)\b'` found **6 match lines, none actionable** — unchanged in character from prior weeks. (TODO 5 occurrences, XXX 2 — both XXX on one format-literal line; FIXME 0, HACK 0.)

### 5a. Narrative / resolved-work references + the format-literal false positive (6 lines)

- `app/api/rtr/lock-roi/route.ts:38` — "v2 folds in the two signals the v1 TODO called out" (describes resolved work).
- `lib/rtr-lock-roi-weights.ts:7` — "resolves the standing 'calibrate the absolute curve' TODO" (resolved).
- `lib/chains/solana/normalize.ts:47` — "previously held as a TODO placeholder" (resolved).
- `lib/format.ts:6` — the `"$X,XXX.XX" / "-$X,XXX.XX"` format doc comment; the `XXX` here is a format-string literal (twice), the exact false positive the task names.
- `supabase/migrations/20260713050000_audit_20260713_wmc_team_name_denorm.sql:4` — "Motivation (was a TODO in CollectionMomentTable.tsx)" (migration already shipped; past-tense reference).
- `supabase/migrations/20260919173527_panini_bridge_candidates…sql:30` — "each is a pre-flip decision, **not a TODO**" (explicitly not a marker).

> **Net change since last week:** none of consequence. Live application code has **zero actionable** TODO/FIXME/HACK/XXX markers. `scripts/`, `workers/` (non-vendored) and `supabase/functions/` scanned clean. `TODO_`-prefixed launch-flag guard strings (which do not match `\bTODO\b`) persist by design.

---

## 6. Resolved / no action needed

Verified against the register STATUS INDEX, the ledger, the 11-01/11-02 overnight metrics + handoffs, and the monthly review:

**Newly resolved / landed / decided since last week (2026-10-26 → 2026-11-02):**
- **#22** — Dapper credential residue RESOLVED 10-26 (Trevor signed out all devices; token past lifetime).
- **#212** — LiveToken credential residue RESOLVED 10-26 (Trevor signed out; server-side session ended).
- **#202** — Panini LOW tier ask-cap RESOLVED 10-26 (panini-1.4.1 BEFORE INSERT guard; 2,029 rows re-stamped $39,269 → $22,142; shadow backtest met the pre-registered rule).
- **#198** — All Day V1 listing re-verify RESOLVED 10-27 (production proof met: 0 dead of 7,158 re-checked; 11 ticks dispatched + drained).
- **#193** — Disney Pinnacle HIGH tier RESOLVED 10-30 (last-5 median met its exit two weeks running; HIGH ranks above MEDIUM; nothing reverted).
- **#214** — the home deal-alerts box rewritten as a waitlist ("coming soon") RESOLVED 10-26 (pinned so the old claims can't return).
- **#215** — fmvBasis capped-price marker on every eligible caller RESOLVED 10-30.
- **#216** — public Top Shot boards listing a parallel with its set name alone RESOLVED 10-29 (Rippled vs standard now distinguished).
- **#217** — `rpc-reprice-drifted-high-value-rips` first production tick RESOLVED 10-31 (steady state: small fresh-drift re-pricing, not the 170-rip regression shape).
- **#219** — WNBA league backfill / wmc writer RESOLVED 10-31 (re-closed on the writer that actually runs).
- **#220** — a Top Shot offer not in Atlas published as a bid RESOLVED 10-31 (board reads Atlas's view; a bid Top Shot doesn't show is a false claim).
- **#222** — wmc `is_locked` writer discipline + lock state followed from chain RESOLVED 11-01.
- **#224** — UFC Strike art depends on a public IPFS gateway RESOLVED 11-01 (Supabase Storage mirror read first; all 582 UFC CIDs × 4 widths backfilled).
- **Flowty retired 10-30** — the API went dark 10-27; lanes, routes, rows and `flowty-proxy` (410 tombstone) retired per the runbook.

**Note on churn:** the register grew 211 → 223 numbered items in one week (+12), closed +13 (201 → 214), and open+partial *fell* 10 → 9. A build-and-ship surge (collector-utility features + parity + the trophy/art/correctness arc), not a discovery of defects — most new slots shipped-and-closed in the same window, and the current open set is measurement (#213/#221) or operator/Trevor decisions (#223/#225).

---

## 7. Suggested sequence

A pragmatic order under **accuracy-is-the-gate** + the go-live bars (outreach off, gate 100+ WAU):

1. **Run the #223 SQL-editor quarantine (Trevor/operator).** Paste `docs/pending/142-quarantine-run-in-sql-editor.sql` in the Supabase SQL editor to move the 164 cross-collection acquisition rows ($1,673.51 of invented spend) into quarantine and drop the uncalled 2-arg function — it is blocked only by the confirmation prompt no cloud session can answer. P1.
2. **Decide #225 (UFC video mirror).** Choose poster-only / pinned-only / full mirror after re-deriving the ~10–14 GB + per-play-egress sizes; today the trophy displays as its image and only hover-to-play fails, so this is a bounded cost decision, not a fire.
3. **Watch the dated proofs:** #213 STALE low-serial re-read (~**11-05**, after a full All Day week post-Dapper), the weekly demand re-read (~**11-05**), #208 ASK_ONLY weekly hold, Candy share's honest fall (~**11-10**), Candy market re-verify (~**11-27**).
4. **Close the #221 alias half** — make the catalog spelling canonical through the player-identity crosswalk, then let the reconciler overwrite wmc; keep per-player aggregates on `editions.player_name` until then.
5. **Resolve the #114 dashboard roster drift** — decide publish-or-exclude for the 5 extra dashboard sources, update the #114 map and the daytime-monitor §1b roster.
6. **Convert the arriving traffic (the activation lever)** — a no-login, high-intent anon → wallet-paste → "here's your squeeze / EV / what to chase" path, tuned on wallet_paste and outbound-clicks (both growing); get a clean internal-excluded WAU read each week; hold outreach until the 100-WAU gate opens.
7. **Reset the stale DB-size baseline doc** (~4.2 GB June → operating ~42–44 GB) and keep the `net._http_response` sawtooth + Panini growth on watch.
8. **Finish the pricing-cap tails:** #208 weekly hold, #210 remaining haircut sub-classes — each has a falsifier in its item.

---

## 8. Notes from verification

- **Sandbox / device shell active this run.** `git`/`grep`/`wc`/`ls` all work over the connected repo; counts are first-hand. **532 commits** since 2026-10-26 (`git log --since`); mount HEAD `35f35c58b` 2026-11-01 10:50 PT (Claude). Authors: Claude 423, Claude (Cowork) 47, Trevor 40, monitor/nightly bots ~22. ⚠ The mount trails origin — `origin/main` is at `903027572` (tonight's 11-02 nightly: "GREEN, 0 shipped; #114 roster drift queued"); the commit count is from the mount's history.
- **Counts measured this run:** CI = **21** jobs under `jobs:` in `.github/workflows/ci.yml` (unchanged: changes, memory-docs, docs-tests, inherited-status, typecheck, eslint-ratchet, cadence-escrow-tests, unit-tests-shard, unit-tests, component-tests-shard, component-tests, workflow-lint, build-render, worker-tests, workers-typecheck, db-tests, ledger-guard, register-guard, inbox-guard, tree-corruption, edge-deno); DB-invariant test files = **287** (`supabase/tests/*.sql`, `ls`, +10); `app/insights/*/page.tsx` = **38** (+5). Monoliths re-measured (`wc -l`): DashboardClient 3,058 / SniperClient 2,228 / CollectionAnalyticsClient 2,037 / CollectionTabClient 1,664 / MarketClient 1,383.
- **Live metrics (from the 2026-11-02 ~1:03 AM PT overnight pass + the 11-01 pass + the 11-01 monthly review):** DB size **44,349 MB** (~44.3 GB; +2,014 overnight = pg_net sawtooth mid-fill + Panini growth; 42,335 MB the morning before — a ±~1.3–2 GB swing). Trust: **0 breaches / 40 legs ok**. `v_fmv_sanity_flags` 0; `topshot_impossible_parallel_serials` 0. FMV HIGH+MED by collection: Panini 18,022, NBA 6,578, NFL 1,628, Pinnacle 909, Candy 68, Golazos 1, UFC 0. Editions: NBA 14,609, Panini **40,153** (+629 wk), NFL 6,190, Golazos 575, UFC 617, Candy 125. Client-error beacon 0 / 24 h. Vercel 24 h: chronic/benign error groups only (ipfs-media 12 s timeout ×9 chronic since 09-03), no new group. Security clean. 0 shipped / 0 reverted both passes.
- **Accuracy — file-blessed series (roadmap-status 10-29 block, wk 10-26 partial/13–14 legs):** Top Shot 45.0, All Day 27.8, Pinnacle 33.3, Candy 58.2, Panini 45.9, Golazos 0.2, UFC 0.0. Top Shot's ~45 % is the FMV 1.8.2 MEDIUM re-grade (by design). **Read a series, not a leg.** Live Top Shot HIGH+MED ≈ 45 % of 14,609 canonical editions (monthly review; ~half still ASK_ONLY/LOW).
- **Demand:** monthly (11-01, 30 d) WAU 4, MAU 15, 38 accounts, outbound buy-link clicks 222 (↑~18× MoM), 1 email sub; weekly (10-22..10-28) 2 external signed-in, 0 signups, Dapper-confounded. Next weekly re-read ~11-05.
- **TODO scan: 6 match lines, 0 actionable** (§5) — tracked non-docs source via `git ls-files` + `grep -nE '\b(TODO|FIXME|HACK|XXX)\b'`; the two `XXX` hits are the `$X,XXX.XX` format literal on one line; the other 5 are past-tense/resolved references.
- **Deletions verified by absence (`test -e`):** `lib/cart`, `lib/trade-escrow`, `app/dashboard/trade-hub`, `app/dashboard/gift`, `lib/blazers-trivia.ts`, `docs/FREEZE.md` — all absent.
- **Launch flags verified:** `lib/launch-flags.ts` `CANDY_MLB_PUBLIC = true`, `PANINI_PUBLIC = true`; Trade Room kill switch `RPC_TRADE_ROOM_EXECUTE` present (`lib/trade-room/execute.ts`).
- **Cited paths spot-checked — all resolve, no stale references found** (the paths referenced by the current open/partial items + core honesty helpers): `docs/strategy/roadmap-2026-10-17.md`, `docs/strategy/go-live-2026-09.md`, `docs/reference/{known-issues,roadmap-status,architecture-notes,topshot-ownership-index}.md`, `lib/{api-error}.ts`, `lib/insights/board-status.ts`, `lib/analytics/fetch-json.ts`, `lib/og/board-empty-copy.ts`, `lib/launch-flags.ts`, `lib/address.ts`, `lib/trade-room/execute.ts`, `docs/pending/142-quarantine-run-in-sql-editor.sql`, `scripts/demand-read.sql`, `docs/archive/audits/livetoken-api-intelligence.md`, `__tests__/no-credential-literals-in-tracked-files.test.ts`. **Absent (correctly):** the four deleted product dirs, `lib/blazers-trivia.ts`, `docs/FREEZE.md`.
- **Known-issues STATUS INDEX:** its own generated line reads **223 numbered items — 4 open · 5 partial · 214 closed**; the 4 open are **#213, #221, #223, #225**; the 5 partial are **#66, #208, #209, #210, #218**; the newest filed slot is **#225**.
- This report did **not** edit `CLAUDE.md` or any source file and did **not** touch git — it only created this file.

---

## 9. Known-issues reconciliation (verified 2026-11-02)

The register's own generated STATUS INDEX reports **223 numbered items — 4 open · 5 partial · 214 closed**. ⛔ `closed`/`open` means the item *says* so — read its own date stamp. The current open/partial set and the items that moved since last week:

| # | Issue | Index status | Verified status | Evidence |
|---|---|---|---|---|
| 213 | #209 STALE cap ignores serial ≤ 25 | 🟡 **open** | RE-OPENED 10-29 — premium-serial rule measured, not shipped (n too small); re-read ~11-05 | known-issues #213 |
| 221 | wmc player-name spelling variants | 🟡 **open** | NEW 10-31 — user-visible filter fixed 11-01 (`_norm_player`); aliases + canonical crosswalk open | known-issues #221 |
| 223 | #142 moment_id collision inside one wallet | 🟡 **open** | NEW 11-01 — all session fixes shipped; one SQL-editor quarantine paste (164 rows) remains (Trevor) | known-issues #223 |
| 225 | UFC Strike video gateway-bound | 🟡 **open** | NEW 11-01 — poster from #224 mirror; video mirror is a ~10–14 GB infra-cost decision (Trevor) | known-issues #225 |
| 66 | SEO / zero external links | 🟠 partial | Code items done; 10-28 Search Console re-read done (49.4K indexed); external links Trevor's, gated | known-issues #66 |
| 208 | All Day + Golazos ASK_ONLY cap | 🟠 partial | PARTLY RESOLVED 10-22/10-23 — price capped (1.80 → 1.00); weekly hold open | known-issues #208 |
| 209 | Top Shot + All Day STALE cap | 🟠 partial | PARTLY RESOLVED 10-23 — price capped at last sale; basis line Trevor's | known-issues #209 |
| 210 | Thin-sale haircut depth floor | 🟠 partial | PARTLY RESOLVED 10-23 — 0-sale cells now 0.75 (was 0.55); remaining sub-classes open | known-issues #210 |
| 218 | Dapper Studio pack index froze; "Live asks" over it | 🟠 partial | PARTLY RESOLVED 10-30 — Atlas failover shipped; the chain (`pack_purchases`) is the witness | known-issues #218 |
| 202 | Panini LOW tier ask-cap | ✅ closed | RESOLVED 10-26 (panini-1.4.1 BEFORE INSERT guard; was open last week) | STATUS INDEX |
| 193 | Disney Pinnacle HIGH tier | ✅ closed | RESOLVED 10-30 (last-5 median met exit; was partial last week) | STATUS INDEX |
| 198 | All Day V1 listing re-verify | ✅ closed | RESOLVED 10-27 (production proof met; was partial last week) | STATUS INDEX |
| 22 | Dapper credential purge | ✅ closed | RESOLVED 10-26 (Trevor signed out; token past lifetime; was partial last week) | STATUS INDEX |
| 212 | LiveToken session | ✅ closed | RESOLVED 10-26 (Trevor signed out; was open last week) | STATUS INDEX |
| 214–220, 224 | the 10-26→11-01 waitlist / fmvBasis / parallel-label / reprice / league / offer / lock / UFC-art cluster | ✅ closed | all resolved/decided in-window | STATUS INDEX |

**Tally (per the register's own STATUS INDEX):** **223 numbered items — 4 open · 5 partial · 214 closed**, newest slot **#225**. Plus the go-live plan, the per-collection accuracy legs, Candy live (market frozen) + Panini walked & parity-built + the collector-utility layer + Rewards paused, **21-job CI**, **287 DB-invariant test files**, and **38 public `/insights` surfaces**.

**Bottom line for `CLAUDE.md`:** another heavy, clean week (532 commits), all interactive Cowork / Claude Code, with the autonomous pass green-and-idle every night. The arcs this week were a **collector-utility layer** (the no-custody Trade Room went to live signing 10-31, the "Top Shot This" trade-in finder, follow-a-player, player checklists), **All Day / Candy / Pinnacle parity** (the RPC Index for All Day, serial-premiums, Hot Floors, character pages, the packs Chase view), and a **trophy/art/correctness arc** (the UFC art IPFS→Supabase mirror #224, the Pack Sniper Atlas failover #218, the offer-not-in-Atlas false claim #220, the lock-lane rework #222, the parallel-label fix #216). Open+partial *fell* **10 → 9**, and the two credential residues that topped last week's P0/P1 list (**#22**, **#212**) both closed when Trevor signed out 10-26, alongside the scheduled closures of **#202**, **#193** and **#198**. Live trust metrics are fully clean (0 impossible serials, 0 FMV sanity flags, 0 arm breaches). On the front page, **Top Shot is MET on its series (~45 % leg by design), All Day is still short (27.8 %)**, DB is ~42–44 GB on legitimate Panini growth + the pg_net sawtooth, and **demand is still the one number that decides everything** — WAU 4 against a 100-WAU gate with outreach off, though buy-link clicks surged ~18× month-over-month and the drop-off is now clearly at the authed step. The standing asks are operator/Trevor: the **#223** SQL-editor quarantine paste (164 rows / $1,673.51 invented spend), the **#225** UFC-video infra-cost decision, the **#114** dashboard roster-drift resolution, and converting the arriving traffic into returning authed users.
