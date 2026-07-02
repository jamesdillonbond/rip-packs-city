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
