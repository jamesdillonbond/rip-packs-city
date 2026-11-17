# RPC weekly data-quality + reconciliation sweep — 2026-09-22

**Status: NEEDS ATTENTION** — one new integrity flag: the Top Shot `wallet_moments_cache` NULL-`edition_key` count spiked **144 → 19,625** since the 09-08 sweep. It is a datable drain event (2026-09-11), concentrated (21 wallets, 3 large), and **not** actively growing (13 rows re-seen in 48h). Live blast radius is small (65 NULL moments across 4 seeded wallets); the bulk is non-seeded on-demand-lookup wallets. Handed off, not live-patched (ingest is off-limits to this sweep). Everything else is clean or flat. Read-only pass; nothing shipped but this digest + the handoff doc.

## This week

1. **FMV sanity** (`v_fmv_sanity_flags`) — **0 rows.** No edition diverges from its set's sales-median. Clean.
2. **Offer reconciliation** (`v_offer_sanity_flags`) — **1,015 rows** (down from **1,328** on 09-08), largest `gap_usd` **$3,588**, avg **$38**. Composition: `chain_exceeds_gql` 631 + `gql_blank_chain_has` 384; **1,011 of 1,015 (99.6%) are `has_sub_serial=true`** — the known structural case where the GQL edition-offers aggregate collapses subedition/serial offers. Only **4** non-sub-serial. Count **declined** week-over-week; not a regression.
3. **Integrity** —
   (a) editions with no `fmv_snapshot` (canonical filter; Pinnacle render-keyed, excluded): **0** across TS / AllDay / Golazos / UFC.
   (b) `wmc` orphan contract (edition_key with no matching `editions.external_id`): **TS 19,625 ⚠**, AllDay 7, UFC 2, Pinnacle 50,957 (structural — render-keyed, never in `editions`, orphan-by-definition). **The TS number is the flag** — see Flags.
   (c) sales in last 7d with null edition mapping: **0** (TS 16,256 / AllDay 3,026 / Candy 372 all fully mapped).
4. **`unmapped_sales` backlog** (unresolved) — AllDay **69,665** (down ~25,600 from 95,307 — legacy dead-letter still actively draining), UFC **1,070** (static), TS **23**, Golazos **26**. Recent sales map cleanly (3c), so benign historical residual, not live integrity loss.
5. **TS sentinel** (malformed `external_id` created <48h) — **0** (threshold ok<250). Clean.
6. **FMV freshness + coverage** — latest `computed_at`: TS **3.5 min**, AllDay **3.5 min**, Golazos **17.8 min**, UFC **128 min** (structural ~2h cadence for a thin collection, not alert-grade), Pinnacle `pinnacle_fmv_history` 8.3h / `pinnacle_catalog` floor_ask 4.7h (daily rewrite cadence — healthy). HIGH+MEDIUM (DISTINCT-ON latest): **TS 7,761 (HIGH 1,348)** — well above the ~400 HIGH floor; AllDay 1,923 (HIGH 76); Golazos 4; UFC 0 (thin-sales collections, structural). Engine healthy.
7. **Pack-EV staleness** (`snapshotted_at` >3d) — **TS 1,059 / 1,210** (flat vs 1,061 on 09-08), AllDay 722 / 3,130, Golazos 0 / 211, Pinnacle 0 / 91. Flat; already scoped by `docs/handoff-2026-09-01-topshot-pack-ev-secondary-staleness.md` — not re-filed.
8. **Offer-indexer liveness** — `topshot-offers-indexer` **72 runs / 0 fails**, `allday-offers-indexer` **72 / 0 fails**, both last-ran minutes ago. `offers` table **192,764 total / 25,625 open** (up from 173,130 / 24,842 on 09-08 — healthy growth).
9. **Schema-truth drift** — **zero drift in the volatile facts.** `pinnacle_fmv_snapshots` still ABSENT (`to_regclass` NULL), `pinnacle_fmv_history` present; every table CLAUDE.md names exists; enums byte-identical to the committed snapshot — `fmv_confidence` {HIGH,MEDIUM,LOW,ASK_ONLY,SALES_ONLY,STALE,NO_DATA} (7), `tier_type` {ULTIMATE,LEGENDARY,RARE,UNCOMMON,FANDOM,COMMON,CHAMPION,CHALLENGER,CONTENDER} (9), `chain_type` {flow,ethereum,polygon,solana,flow_evm} (5); RLS-off public tables **0** (invariant holds). Public base-table count **455** (informational creep: 372 on 08-25 → 423 on 09-08 → 455). ⓘ `docs/reference/schema-truth.md` "Last generated" is **2026-08-22 (31 days old)** — no drift found, but due for regeneration by the nightly pass / Claude Code.

## Flags

**⚠ NEW — TS `wallet_moments_cache` NULL-`edition_key` spike (integrity, medium; ingest fix, handed off).**
- Count **144 (09-08) → 19,625 (today)**. All 19,625 have `edition_key IS NULL` (not a mismatched key) → `player_name` NULL, `fmv_usd` NULL for every row: fully unresolved moments.
- Concentrated in **21 wallets**; the top 3 (`0xa2d42d20ad998e78` 9,250, `0xd9db9ac2cfcdeba4` 5,216, `0xcb5e15ebe4440e35` 3,900 = 18,366 rows) were each written in a single scan on **2026-09-11 05:46–05:57 UTC** and **never re-seen** (`first created ≈ last seen`). A handful more (50-row batches) on 09-13/14/16.
- **Not actively growing:** only 13 NULL rows re-seen in 48h, 314 in 7d. This is a stale one-time write, not a runaway.
- **Live blast radius is small:** only **4 of 21 wallets are `seeded_wallets`** (user-facing), carrying **65** NULL moments total (50/13/1/1). The three large wallets are **non-seeded** — reached only via on-demand wallet lookup, where they'd render nameless/valueless.
- **Honesty-canon match:** a `wmc` row with NULL `edition_key` is a moment shown as "unknown" that is very likely KNOWN (CLAUDE.md, #80). The wmc drain wrote unresolved rows rather than resolving-or-skipping. **Off-limits to this sweep** (ingest logic) → handoff written: `docs/handoff-2026-09-22-topshot-wmc-null-edition-key-spike.md`.

**Standing recommend (not re-filed, unchanged): offer `edition_offers` GREATEST-raise.** The offer-sanity set is stable and ~100% sub-serial — the documented durable-fix case. When the offer crons have accrued, raise `edition_offers` via a GREATEST-based update (never clobber down). Flagged only; not written.

**ⓘ schema-truth.md regeneration due** — 31 days old, no drift this cycle, but flag for the nightly pass / Claude Code to regenerate `docs/reference/schema-truth.md`.

## Suggested actions

1. **Claude Code:** work `docs/handoff-2026-09-22-topshot-wmc-null-edition-key-spike.md` — find why the TS wmc drain wrote NULL `edition_key` for ~18.4k moments on 2026-09-11, add a resolve-or-skip guard, and decide the disposition of the existing 19,625 stale NULL rows (re-resolve on next scan vs prune). Verify the 4 seeded wallets' 65 NULL moments re-resolve.
2. **Nightly pass / Claude Code:** regenerate `docs/reference/schema-truth.md` (31 days stale; volatile facts confirmed drift-free today).
3. No pricing/FMV/ingest touched here. FMV sanity, offer reconciliation, sales mapping, sentinel, indexer liveness, and schema enums all clean.
