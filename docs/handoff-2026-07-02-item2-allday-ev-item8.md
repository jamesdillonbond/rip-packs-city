# Claude Code handoff — Item 2 (All Day EV) remaining + Item 8 scope (2026-07-02)

Round-2 of the audit follow-ups. Cowork shipped the substantive fix; two small code bits + Item 8 need the dev loop. Read on desktop. Working agreement: commit to `main`, no branches/PRs, verify live.

## Item 2 — All Day Pack EV → circulation-weighted — SHIPPED by Cowork (verify + finish)

**Done + verified live (via MCP):**
- Edge fn `compute-allday-pack-ev` redeployed **v8** (Supabase version 25 ACTIVE): pool rows now carry `drop_weight = orig_drop_weight = per-dist-normalized circulation share (0,1]`, and it calls `compute_pack_ev_per_edition_weighted` (was `drop_weight=1` + the equal-weight-trimmed `compute_pack_ev_from_pool`). Dapper doesn't populate AllDay `packOdds` (empty every run), so supply-weighting is the authoritative signal — matches the already-circ-weighted `v_allday_pack_realized_ev`.
- One-time primed all AllDay `pack_drop_pool` to circ weights (**590 distinct weights now, was 1**; all in (0,1], no overflow/nulls) so per-edition "Wt"/EV-share/Top-Pulls displays are correct immediately.
- Verified: Grail Seeker (4370) weighted gross_ev **$3.00** vs equal-weight $51 untrimmed / $3.13 trimmed; realized $2.19. RPC path `ev_basis=original`. `check_public_security_invariants()` `[]`.

**Remaining (CC):**
1. **Sync the repo edge fn to v8.** The live deploy was via MCP; `supabase/functions/compute-allday-pack-ev/index.ts` in the repo is still v7. Pull the deployed v8 (`get_edge_function` / the version-25 body) into the repo so git matches. **Until synced, do NOT `supabase functions deploy` that function from the repo — it would revert to v7.**
2. **Pack-page copy.** `app/(collections)/[collection]/pack/dist/[distId]/page.tsx` has an AllDay warning "the canonical AllDay model averages all editions equally, over-stating rare-heavy packs." That's no longer true — update to reflect supply/circulation-weighted EV. (The `compute_pack_ev_from_pool` comment ~line 250 is also now stale for AllDay.)
3. **Verify the headline self-heals.** The headline "Gross EV" KPI reads `pack_ev_latest ← pack_ev_history`, refreshed by the every-30-min v8 cron cycling all 3,112 AllDay dists (~15h to fully cycle). Confirm a v8 run logs `function_version:8, ev_method:circulation_weighted` (next tick after 03:17Z UTC 2026-07-02) and that a chance pack's headline EV drops to the circ-weighted value. Brief window where headline (equal-weight) and per-edition Wt (circ) differ until the cron cycles — expected, converges.

**Revert:** redeploy v7 edge fn (git history) + `UPDATE pack_drop_pool SET drop_weight=1, orig_drop_weight=NULL WHERE collection_id='dee28451-5d62-409e-a1ad-a83f763ac070'` + revert the `compute_pack_ev_from_pool` RPC call.

## Item 8 — All Day enrichment — CONFIRMED BLOCKED (needs deployed env / external data)

Independently re-measured; none are shippable/verifiable from Cowork:

1. **Jersey-match special serial — no data source.** `editions.jersey_number` = 0/6191 AND `players.jersey_number` = 0/1517 for All Day (TS has 1,214 players with jersey). There is no NFL jersey data anywhere in the DB. Build: probe the studio-platform GQL (`searchEditions`/moment metadata) or an NFL roster source for jersey numbers → a `backfill-allday-jersey` pipeline → populate `editions.jersey_number` → the special-serials RPC picks it up. Medium build, niche feature — gate on priority.
2. **Buyer recovery — needs on-chain, deployed route.** ~12.6% of All Day 90d sales have an unresolved buyer: 1,579 are the Flowty fee-router `0x3cdbb3d569211ff3` and 2,261 are null (of 30,352). Recover via the existing `fetchTxBuyers` / forward-`Deposit`-scan (AllDay real buyer = `A.e4cf4bdc1751c65d.AllDay.Deposit.to`, per CLAUDE.md) run from a deployed route with proxy creds — not runnable/verifiable from an MCP session. Quick display mitigation meanwhile (optional): render the known router address as "—/via marketplace" in Recent Sales instead of the raw 0x.
3. **Username resolver tail** — operational cron tuning (raise `wallet-username-resolver` batch/frequency for the unresolved tail).

Priority: repo-sync + page-copy (Item 2 finish) are quick; Item 8.1/8.2 are real builds — schedule when jersey/buyer intel is worth it.

---

## Post-ship watch (2026-07-02 ~03:56Z) — platform GREEN, 3 residuals for CC

Full re-sweep after the day's wave (F1 re-key+writer, F2 dedup, Item 2 EV v8, Pinnacle enrichment): security 0/0/0/0, trust-health 15/15 ok, 0 stalled pipelines, editions FLAT, sentinel 0, fmv_sanity 0, v8 AllDay EV run confirmed (`function_version:8`). No regressions. Three residuals — none are fires, all self-healer-covered, but two have a real root-cause worth a proper writer fix:

> **DISPOSITION (2026-07-02, CC):** F1 CLOSED (`8064801` — sales-indexer resolver "when unmapped, base" guard, Step 4e). F4 CLOSED (`c5db7a4` — reward-pack dead-KPI display suppression). F2 ANALYZED → deliberately NOT shipped: a correct ingest dedup must keep the *richer* row (the sweeper's semantics); a skip-if-exists hot-path trigger degrades data quality and the trickle is ~0.08%, steady-state-covered by the daily sweep. See ledger 2026-07-02.

1. **F1 writer still has a small `onchain`-path gap (root cause for a complete fix).** After the a9c011c writer fix, one Standard sale still landed on a `::` parallel post-fix: nft `52062637` (serial 551, source `onchain`, ingested 03:43Z) → `257:8664::18` (Hardcourt /50). It's **not** in `topshot_moment_subeditions` and has **no linking moment** — so the sales-indexer's edition *resolution* itself picked the `::18` parallel for a Standard nft. The `isCanonicalExtId` guard passes because `::18` is canonical *format*; the gap is the resolver choosing the wrong canonical edition. Complete fix = on the `onchain` resolution path, an unmapped nft (not in the submap) must resolve to the **base** `setID:playID`, never a `::subID` — a "when unmapped, base" guard on resolution, not just format validation. (I re-keyed this one via `audit_20260702_reattribute_impossible_parallel_sales_sweep`, reversible, detector back to 0; CC's daily self-healer also covers it, but the trickle continues until the resolver gap is closed.)
2. **F2 dedup is a sweeper, not a writer-key fix.** 25 new AllDay cross-source dupes appeared in a ~4-min backfill burst (03:52–03:55Z) — the studio-history + onchain indexers still WRITE the same economic sale under different tx representations; CC's daily pg_cron collapses them but the writer keeps producing. Steady-state is fine (cron sweeps daily), but the durable fix is a cross-source dedup key at ingest (`nft_id + round(price,2) + day`), not just the sweeper.
3. **F4 pack opened/minted reconciliation (LOW, display, 7 packs).** Only 7 TS dists (all reward packs, retail=0) show observed `pack_rips` >> `pack_distributions.total_minted` (e.g. 7800: 21,155 rips vs 3,240 "minted"). The dist counters (`total_minted`/`total_opened`) are dead-by-design (see `pack-lifecycle-data-model`); the pack page's "minted / packs-remaining / depletion" KPIs read them, contradicting the observed "opened" KPI right beside it. Fix (display): for reward packs (retail=0), suppress or repoint the minted/remaining/depletion KPIs to observed lifecycle data (`v_topshot_pack_lifecycle`) — don't hack the dead counters. **(SHIPPED by CC `c5db7a4` — reward-pack dead KPIs suppressed; verified live.)**

---

## QA sweep of previously-untested surfaces (2026-07-02) — 1 new LOW finding

Swept the surfaces the audit sampled but didn't exhaust. All healthy except one:

- **All 16 public /insights boards** — backing data all non-empty + sane (squeeze 7,255 · deals 817 · offer-spread 5,604 · allday-scarcity 6,190 · pinnacle-scarcity 2,272 · rookies 61 · trophies 731 · allday-pack-realized-ev **420**, up from 147 = v8 EV cron populating · etc.). Squeeze board renders correctly (KPIs, filters, sort, table, methodology). PASS.
- **Concierge** — 0 `concierge-model-error` rows in 7d, 246 conversations, last one live. Model-retirement fix holds. PASS.
- **Golazos + UFC edition templates** — render fine (FMV, history, sales, special serials); DB art coverage healthy (Golazos 575/581, UFC 518/518). UFC correctly shows the "migrated to Aptos 2025-07-30, buy flows disabled on Flow" banner. Weak buyer/seller resolution on both (historical `— —` / Flowty router) — same class as All Day, low priority.

**NEW (LOW) — UFC (and any ipfs.io-served) edition hero media renders as an empty black box.** Hero moment art/video doesn't display even after 10s. Diagnosed: **not** CSP (`ipfs.io` is in both `img-src` + `media-src`), **not** a dead URL — the asset fetches `statusCode 200`. The hero just doesn't paint it, almost certainly because UFC media URLs are extensionless IPFS hashes (`https://ipfs.io/ipfs/Qm…`) and `ipfs.io` returns a generic content-type, so the `<img>`/`<video>` won't render. TS/AllDay use typed CDN URLs and render fine. Fix (hero media component): route ipfs.io media through the app's image/media proxy (sets a correct `image/*`/`video/*` content-type) or add explicit `type=` hints / poster fallback. Low priority — UFC is Flow-historical. Golazos hero was also empty on one dormant edition (`assets.laligagolazos.com`, 99% coverage collection-wide) — spot-check a few more before assuming systemic. Minor: the Golazos "STATUS UNCERTAIN — buy flow temporarily unavailable" banner copy reads stale ("temporarily"); refresh it or use the UFC-style migration banner if Golazos secondary is dead-on-Flow.

Not individually clicked this pass (same verified-healthy data layer, no error signal): share/profile, analytics dashboards, sniper/market tabs.
