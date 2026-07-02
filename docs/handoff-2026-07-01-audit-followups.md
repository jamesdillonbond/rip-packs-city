# Claude Code handoff — 2026-07-01 comprehensive-audit follow-ups

Paste this whole doc to Claude Code. Read on desktop (normal markdown). Full audit: [docs/audits/comprehensive-audit-2026-07-01.md](audits/comprehensive-audit-2026-07-01.md). Roadmap: [docs/roadmap-2026-07.md](roadmap-2026-07.md).

**Working agreement (non-negotiable):** commit and push directly to `main`, no branches, no PRs. Verify each item live (DB row counts / deploy READY / smoke). Run `SELECT public.check_public_security_invariants();` (must stay `[]`) after any migration. `apply_migration` for DDL, `execute_sql` for reads. Supabase project `bxcqstmqfzmuolpuynti`; TS collection_id `95f28a17-224a-4025-96ad-adf8a4c63bfd`. Every migration gets a revert path.

## Already shipped by the Cowork audit session (do NOT redo)
- **F1 partial data fix** — re-keyed 229 mis-attributed parallel sales back to base (migration `audit_20260701_reattribute_impossible_parallel_sales`, backup table RLS-on). Impossible-serial count 240→6. This is a **one-time** correction; the writer still leaks (Item 1 below stops re-accumulation).
- Two docs above committed to `docs/`.

## Operator items — flag to Trevor, CC cannot do these
- **🔴 Raise the Vercel on-demand spend cap** — on track to pause production ~early July.
- **Raise Supabase PostgREST `db-pool`** (Settings → Database) — fixes the intermittent edition/pack "Timed out acquiring connection from connection pool" (Postgres has headroom; it's a pool-size setting).

---

## Item 1 — STOP the parallel mis-attribution writer leak (HIGH, data accuracy)
The sales-indexer is keying a fraction of **Standard** TS moments' sales onto new S8 `::` parallel editions (Club Collection `::16`, Hardcourt `::18`), producing impossible serials (serial > the parallel's circulation) at Standard-common prices. Leak started ~2026-06-24, ~7 new/day, sources `onchain` + `offer_fill`.

- **Detector (should trend to ~0 after fix):**
  ```sql
  SELECT count(*) FROM editions e JOIN sales s ON s.edition_id=e.id
  WHERE e.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND e.external_id ~ '::'
    AND e.circulation_count>0 AND s.serial_number > e.circulation_count;
  ```
- **Root cause to find (read the code, don't assume):** in `app/api/sales-indexer/route.ts` (and `/api/ingest`), the edition-resolution / `redirectParallelSales` path for these subedition types. An unmapped Standard nft (`serial > any parallel circ`, not in `topshot_moment_subeditions`) must resolve to the **base** `setID:playID`, never a `::subID`. Confirm whether Club Collection/Hardcourt are being over-matched by the subedition resolver.
- **Two deliverables:** (a) writer guard so a Standard nft can't land on a `::` edition; (b) a durable **parallel→base** remap (the existing `remap_topshot_base_keyed_parallel_sales()` only does base→parallel) wired into the daily drain so the residual + any future strays self-heal. Also clean the 6 residual non-airtight cases (verify each — some may have no base, serial>base circ, or a tx collision).
- **Verify:** detector → ~0 and stays there over 48h; spot-check a `::` edition page (e.g. `224:8241::19` Hexwave /25) shows no serial > its mint in Recent Sales.
- **Revert (the one-time data fix, if ever needed):** `UPDATE sales s SET edition_id=a.old_edition_id FROM audit_20260701_reattribute_impossible_parallel_sales a WHERE s.id=a.sale_id;`

## Item 2 — All Day Pack EV → drop-weighted (HIGH parity)
All Day pack EV currently uses **uniform** weighting — every edition `Wt 1`, flat `Hit 0.19%` — so it over-states rare-heavy packs (the pack page prints its own warning). Replicate the TS drop-weighted model:
- Source per-edition pull odds from the Dapper studio-platform `searchDistributions` GQL (secret-free `Origin`-header path already used by `pinnacle-catalog-backfill` + the All Day studio-history crons). This is the same shape that unblocked Pinnacle Pack EV.
- Populate per-edition `drop_weight` for All Day pack pools → weighted EV via the existing `compute_pack_ev_per_edition_weighted` path → calibration vs realized pulls (mirror TS).
- Also fix the All Day pack **Depletion** reading 0% while 75% opened.
- **Verify:** an All Day pack page (e.g. dist `7580` Rewind Chance) shows varied per-edition weights + a calibrated EV, and the "averages all editions equally" warning is gone.

## Item 3 — All Day duplicate sales (MED, ~1%)
295 duplicate groups / 295 excess rows out of 30,571 (90d): `allday_studio_history_v1` and the `onchain`/`onchain_dapper_v1/v2` indexers ingest the same economic sale with different tx representations, so tx_hash dedup misses them.
- **Fix:** a cross-source dedup key (e.g. `nft_id + round(price_usd,2) + date_trunc('day',sold_at)`) at ingest, plus a one-time reversible collapse keeping the most-resolved row.
- **Detector:** same `nft_id`+price+day appearing in >1 row (I used this to find them).
- **Verify:** detector → 0 new after the writer change; one-time collapse backed up in an `audit_*` table.

## Item 4 — Serial "#0" display (LOW, high visibility)
3.5% of TS 90d sales (8,495/240,120) have `serial_number=0` (unresolved) and render literally as "#0" on edition + team + pack Recent Sales. Serials start at 1, so #0 is wrong-looking.
- **Fix (display):** render `serial_number = 0` (and null) as "—" wherever serial is shown (`app/(collections)/[collection]/edition/[slug]/page.tsx` Recent Sales; team page market activity; pack sales history). All Day already shows "UNRESOLVED" — match that convention.
- **Optional (data):** a backfill to resolve real serials for the 0-serial rows via on-chain lookup (bigger; display fix is the quick win).
- **Verify:** grep a TS edition page's Recent Sales — no "#0".

## Item 5 — Pinnacle sales enrichment (MED parity, cheapest Pinnacle wins)
Pinnacle render pages (`/pinnacle/moment/{render_id}`) show Recent Sales as **date/price only** — serial is always "—" and there's **no buyer/seller** (TS/All Day show serial + buyer + seller usernames).
- Capture `serial_number` and buyer/seller on Pinnacle sales ingest (`pinnacle_sales`), resolve buyer/seller usernames via the existing `wallet-username-resolver` path.
- Add the **FMV history chart** to the render page (data already exists in `pinnacle_fmv_history`, engine `pinnacle-2.0.0-render`).
- **Verify:** a liquid render (e.g. `SEV1-MNF-MICK-S1`, 536 sales) shows serials + buyer/seller + an FMV chart.

## Item 6 — Pinnacle Pack EV + Packs tab (HIGH parity, review-gated build)
Pinnacle has **0 pack distributions** — no Packs tab, no Pack EV, no Pack Sniper. Probing (07-01) proved it end-to-end: typename `A.edf9df96c92f4595.PackNFT.NFT`, odds via `searchDistributions`, editionIds → `pinnacle_catalog`; worked example Pixar Sketchbooks EV $36.16 vs $49.95. **Confirmed: supply-weighted is correct; uniform is garbage (531× on parallels).**
- Build a Pinnacle pack indexer → `pack_distributions` + pool with **supply-weighted** drop weights (`∝ total_supply`) → EV → add the Packs tab + pack pages (reuse the TS/All Day pack template).
- Gate on Trevor's go (one drop at a time). See [docs/handoff-2026-07-01-pinnacle-pack-ev-measured-finding.md] for the measured method.

## Item 7 — Pinnacle overview polish (LOW)
- `pinnacle_catalog.set_name` has leading/trailing whitespace on 397/2272 rows; `pinnacle_editions.set_name` is clean (0). **Before trimming**, confirm no live join uses the spaced form (check `pinnacle_sales` + any view joining catalog on set_name) — then trim catalog to match. Revert: none needed if you back up the pre-trim values.
- Refresh the stale overview news blurb in `lib/collections.ts` ("Pinnacle on Flow — 231 editions tracked", dated 2026-03-28; now 499).
- Fix the confusing "Scarcity vs variant −559.2% MORE COMMON" copy on render pages (negative % reads badly).
- Some Recent-Top-Sales rows on the overview show "—" for character (render→character unresolved) — resolve or hide.

## Item 8 — smaller parity gaps (LOW)
- All Day **jersey-match** special serial row is missing (TS shows #1/jersey/perfect; All Day shows only #1/perfect). Add it if All Day jersey data is present.
- All Day buyer resolution: recover real buyers from the Flowty-router / Dapper-intermediate address (`0x3cdb…1ff3`) via the existing `fetchTxBuyers` / forward-Deposit-scan so Recent Sales stop showing `— —` / raw router addresses.
- Username resolver: prioritize the unresolved ~2.3% tail (skews toward high-value parallel buyers — why some `::` pages show raw `0x…`).

---

### Priority order
Item 1 (accuracy) → Item 2 (All Day EV) → Items 3/5 (dedup + Pinnacle sales) → Item 4 (serial display) → Items 7/8 (polish) → Item 6 (Pinnacle packs, gated). Operator items first if the Vercel cap is close.
