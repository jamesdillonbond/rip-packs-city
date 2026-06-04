# Claude Code handoff — Remaining work after pack-dist fix

Date: 2026-05-26 (afternoon)
Supersedes (for forward work): `docs/handoff-2026-05-26-entity-pages-and-feeds.md` — that doc remains the canonical record of the original audit, including the §2 dry-run methodology you'll re-run below.

This prompt is the punch list for everything still pending. Status of the original 7 sections:

| § | Topic | Status |
|---|---|---|
| 1 | Pack-dist crash | **DONE** (commit `7f493b2` — `tierChip` extracted to `lib/tier-style.ts`; cause was an RSC client/server function-call boundary). Crash count locked at 3, zero post-fix. |
| 2 | TS editions UUID-dupe merge | **BLOCKED** — dry-run surfaced two pre-flight blockers: `badge_editions` backfill + a `moments` UNIQUE constraint drop. Re-run protocol in Phase 0 below. |
| 3 | Moment / Edition page enhancements | **PARTIAL** — RPCs `get_edition_high_offer` and `get_edition_parallels` are LIVE in DB. Page rendering edits still to ship. |
| 4 | Sniper + Market feed restoration | Pending |
| 5 | Top Shot pack outbound URL fix | Pending |
| 6 | Player / Series / Set polish | Pending |
| 7 | Verification & smoke | Pending |

Work direct-to-`main` per CLAUDE.md. Ship in phases below, in order. After each phase, smoke-test before moving on.

---

## Phase 0 — Re-establish §2 dry-run, identify the merge blockers

The previous session ran the editions-merge migration as a dry-run and found two blockers (badge_editions backfill + moments UNIQUE constraint). Those findings are not captured in any file or memory, so re-run the dry-run from a clean state and document the blockers as you encounter them.

### Dry-run protocol

Apply the merge migration body from `docs/handoff-2026-05-26-entity-pages-and-feeds.md` §2b, but **wrap every `UPDATE` and the final `DELETE` in a single transaction that ROLLS BACK at the end**. This gives you the exact set of constraint violations and FK orphans without mutating anything.

```sql
BEGIN;

-- … the full §2b migration body, verbatim …

-- After the DELETE, capture the rowcounts and constraint state:
SELECT 'editions remaining (TS)' AS metric, count(*)::text AS value
FROM editions WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
UNION ALL
SELECT 'editions UUID-keyed remaining (TS)',
       count(*)::text FROM editions
       WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
         AND external_id !~ '^[0-9]+:[0-9]+$';

ROLLBACK;
```

If any statement fails inside the transaction, Postgres will surface the error and abort — capture it verbatim. Likely errors and their fix:

1. **`badge_editions` backfill required pre-merge.** If `UPDATE badge_editions SET edition_id = m.canonical_id` fails or under-updates, it's because `badge_editions` references a `(player_name, badge_type, series_number)` triple but its `edition_id` FK column is either NULL for many rows or carries the dupe UUID. Write a separate prep migration that re-resolves `badge_editions.edition_id` against the integer-keyed canonical via the `(player_name, set_name, tier, series)` shape that `editions` exposes, then re-run the dry-run.

2. **`moments` UNIQUE constraint drop.** A `moments` (or equivalent) table likely has `UNIQUE (collection_id, set_id_onchain, play_id_onchain)` that was applied during an earlier dedup attempt and now blocks the merge from collapsing rows. Identify the constraint with `SELECT conname FROM pg_constraint WHERE conrelid = 'public.moments'::regclass AND contype = 'u'`, drop it in a prep migration, re-run the dry-run, and re-add a tighter constraint after the merge (probably scoped to integer-keyed rows only via a partial unique index: `CREATE UNIQUE INDEX moments_canonical_play_uniq ON moments(collection_id, set_id_onchain, play_id_onchain) WHERE external_id ~ '^[0-9]+:[0-9]+$'`).

### Deliverable from Phase 0

A short doc — `docs/audits/editions-merge-dry-run-2026-05-26.md` — capturing:

- Exact rowcounts before/after (TS editions count, UUID dupes count, distinct play pairs).
- Each constraint violation surfaced by the dry-run, verbatim.
- The two prep migrations needed (`badge_editions` backfill + `moments` UNIQUE drop).
- Order of operations for the real merge.

Don't move to Phase 1 until the dry-run runs end-to-end inside a `BEGIN; … ROLLBACK;` block with zero errors.

---

## Phase 1 — Ship the editions merge

After Phase 0 dry-run is clean, run the real migrations in this order via `mcp__24ab6d77-3292-4646-b039-669cc9535ef8__apply_migration`:

1. `audit_20260526_badge_editions_backfill_pre_ts_dedup` (prep — backfill `badge_editions.edition_id` to canonical integer-keyed rows).
2. `audit_20260526_moments_drop_play_uniq_pre_ts_dedup` (prep — drop the blocking UNIQUE).
3. `audit_20260526_merge_topshot_uuid_keyed_edition_duplicates` (the §2b body verbatim, no ROLLBACK).
4. `audit_20260526_moments_partial_unique_post_ts_dedup` (re-add tighter constraint as a partial unique index scoped to integer-keyed rows).
5. `audit_20260526_editions_block_topshot_uuid_dupe_trigger` (BEFORE INSERT trigger from §2d).

### Pre-flight before each

Per memory `verify-rowcount-before-destructive-db-ops`, `SELECT count(*)` from the affected table before each `UPDATE` / `DELETE`. Don't trust `pg_stat_user_tables.n_live_tup`.

### Post-merge verification

```sql
-- Expect ~9,139 TS editions (down from 17,106)
SELECT count(*) FROM editions WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd';

-- Avdija Fresh Threads 2024-10-24 — expect ONLY the integer-keyed row, team = Portland Trail Blazers
SELECT id, external_id, team_name FROM editions
WHERE player_name='Deni Avdija' AND set_name='Fresh Threads' AND game_date='2024-10-24';
```

### GQL ingest writer

Find the route that writes UUID-keyed editions on the GQL editions-catalog path (grep for `'searchEditions'` and `external_id` together). Switch it to upsert against the integer-keyed canonical when `set_id_onchain`/`play_id_onchain` are known. The Cadence path remains the source of truth; GQL backfills metadata only. The trigger from migration 5 is the defensive net.

---

## Phase 2 — Moment / Edition page rendering edits

RPCs already live in DB: `get_edition_high_offer(uuid)` and `get_edition_parallels(uuid)`. Files to edit:

- `app/moment/[id]/page.tsx` (per-NFT page)
- `app/(collections)/[collection]/edition/[slug]/page.tsx` (per-edition page)
- `components/MomentDetailModal.tsx` (modal version — keep parity with the standalone page)

### 2.1 Replace MARKETPLACE column with BUYER + SELLER

Both page RPCs already return `buyer_address` + `seller_address` (verified — `RecentSale` interface at `app/moment/[id]/page.tsx` line 87-94 and `SaleRow` at the edition page line 73-83). Just render them.

- New columns: SERIAL · PRICE · WHEN · BUYER · SELLER. Drop MARKETPLACE from the live UI.
- Each address renders as a `<Link href="/profile/<addr>">` to truncated form. Lift the `OwnerLink` helper at `app/moment/[id]/page.tsx` line ~569 into `lib/owner-link.tsx` so the edition page can reuse it without a circular client/server import (be careful — make `lib/owner-link.tsx` server-safe; if it must be a client component, mark it `'use client'` and import as JSX, not a function call, per the new memory `rsc-client-function-call-crash`).
- Wrap buyer/seller with `resolve_canonical_owner(addr)` RPC so HybridCustody children collapse to parents. Cache the resolution client-side per page in a `Map<addr, displayName>`.
- NULL buyer/seller → render "—".

### 2.2 Add "TOP SHOT BEST OFFER" stat cell

Call `get_edition_high_offer(edition_id)`. Place the cell next to "TOP SHOT ASK" in both pages.

- Render: `$X.XX · by <truncated offeror>` with the offeror linked to `/profile/<addr>`.
- NULL → render "—".
- For the per-NFT moment page, if `marketplace_offers` rows can be scoped to `nft_id`, also surface a "Best offer on this serial" line under the edition-level offer. Verify the column shape before wiring (`SELECT column_name FROM information_schema.columns WHERE table_name='marketplace_offers' AND column_name='nft_id'`).

### 2.3 Badges row on moment page

The edition page already renders `detail.badges` (line 300-306). The moment page does not.

- Read `detail.badges` from `get_edition_detail`.
- Render a horizontal `<BadgesRow />` between the FMV pills and the special-serial row.
- Allowlist the 9 core badge titles (`topshotdebut`, `rookieyear`, `championshipyear`, `mvpyear`, `allstar`, `rookiepremiere`, `rookiemint`, `rookieoftheyear`, `threestarrookie`) with red token styling; everything else gets a muted border. The 2026-05-24 batch already set up this allowlist in `app/api/badges/route.ts` — reuse the constant.

### 2.4 PARALLELS section

Call `get_edition_parallels(edition_id)`. Render directly above the existing "Similar Editions" grid.

- Each parallel renders as the same edition-card component used elsewhere with a subtle `var(--rpc-red)` border to differentiate from same-player-different-play moments.
- If the parallels array is empty (the play has no sibling sets), suppress the section entirely.

### 2.5 Special-serial pills (moment page only)

Replace the inline `serial === 1` check at `app/moment/[id]/page.tsx` line 537-554 with a direct query against `special_serial_holders` matching THIS `nft_id`. Render every matching `badge_type` as a red token pill: `#1 SERIAL`, `JERSEY MATCH`, `PERFECT MINT`, `LAST SERIAL`, `BIRTHDATE SERIAL`. The edition page already handles per-edition special serials (line 169-180, 400-423) — don't touch.

### 2.6 Info-bar relocation + correctness

- Move the 6-cell info bar (MINT COUNT · TIER · SERIES · TEAM · PLAY TYPE · GAME DATE) from the footer (`app/moment/[id]/page.tsx` ~line 709-714) into the body, between the FMV pills and Recent Activity (~line 540).
- Mint Count: per-NFT view shows "Serial X / Y" where Y is `circulation_count`. Per-edition view shows just `circulation_count`.
- Series: keep the `SERIES_DISPLAY` mapping (CLAUDE.md series map). Never show raw integer.
- Team: render as `<Link href="/<collection-slug>/team/<team-slug>">`. After Phase 1 the team value is correct.
- Play type: NULL or "Unknown" → render "—".

---

## Phase 3 — Sniper + Market feed restoration

`cached_listings_v2` is alive (34,661 NFL All Day direct rows + 6,656 V1 Dapper; pipelines green). The frontend just doesn't read it.

### 3.1 Investigate where `topshot-listings-indexer` is writing

Run `SELECT collection_id, count(*) FROM cached_listings_v2 WHERE ingested_at > now() - interval '24h' GROUP BY 1`. If TS collection_id is missing, the indexer is writing somewhere else — either the legacy `cached_listings` table or a TS-specific cache. Trace it via grep on `topshot-listings-indexer` in `app/api/` and `supabase/functions/`. Fix is either dual-write to `cached_listings_v2` or migrate the writer to v2.

### 3.2 Write `get_topshot_sniper_deals` RPC

Mirror `get_allday_sniper_deals(6 args)`. Suggested signature: `(p_min_discount_pct numeric, p_max_price numeric, p_min_confidence text, p_tier text, p_set_slug text, p_limit int)`. Implementation: read `cached_listings_v2 WHERE collection_id=TS AND completed_at IS NULL AND (expiry_at IS NULL OR expiry_at > now())`, JOIN latest `fmv_snapshots` per `edition_id`, compute `discount_pct = 1 - (cl.price_usd / fmv.fmv_usd)`, filter by inputs, ORDER BY `discount_pct DESC`, LIMIT.

Grants: `REVOKE ALL FROM PUBLIC, anon; GRANT EXECUTE TO postgres, service_role`.

Smoke test the RPC with `SELECT * FROM get_topshot_sniper_deals(0.1, 10000, 'HIGH', NULL, NULL, 25)` before wiring.

### 3.3 Restore `/api/sniper-feed/route.ts`

Per the May 23 reframe the route is "Top Shot GQL only". Restore the multi-collection branching:

- `nba-top-shot`: keep TS GQL leg + UNION with `get_topshot_sniper_deals` rows. Dedup by `flow_id`.
- `nfl-all-day`: call `get_allday_sniper_deals` (already live).
- `laliga-golazos`, `ufc-strike`: direct `cached_listings_v2` JOIN editions + fmv_snapshots (no RPC yet — inline query is fine for low volume; promote to RPC if it grows).
- `disney-pinnacle`: direct query against `cached_listings_v2` JOIN `pinnacle_fmv_snapshots` (Pinnacle is keyed differently — verify the join shape against `pinnacle_fmv_snapshots.edition_id` type first).
- Drop the "Top Shot GQL only" hardcoding.
- Keep `marketplaceAvailability.flowty: false` and outbound "View Listing →" semantics — DO NOT reintroduce buy buttons (per memory `intelligence-first-decision`).

### 3.4 Restore Market

`app/(collections)/[collection]/market/page.tsx` + its API route. Same wiring as Sniper — query `cached_listings_v2` per collection, render the listing table, outbound link CTA.

### 3.5 Freshness pill

Add an "Updated Xm ago" pill on both Sniper and Market headers pulled from `MAX(ingested_at)` for the active collection. Replace the dormancy red banner concept entirely.

### 3.6 Outbound URLs per collection

| collection | URL pattern (verify each before shipping) |
|---|---|
| nba-top-shot | TS moment page (separate from pack URL — see Phase 4) |
| nfl-all-day | `https://nflallday.com/moments/<nft_id>` |
| laliga-golazos | `https://laligagolazos.com/moments/<nft_id>` |
| ufc-strike | `https://ufcstrike.com/moments/<nft_id>` |
| disney-pinnacle | `https://disneypinnacle.com/<nft-or-pin-path>` (verify) |

`flowty` source listings should NOT be linked (frozen since 2026-05-13).

---

## Phase 4 — Top Shot pack outbound URL fix

The current pattern `https://nbatopshot.com/listings/p2p?packListingId=<uuid>` is dead because TS rotates the UUIDs.

### What to do

1. Server-fetch each candidate URL via `mcp__workspace__web_fetch` against pack 6739 to find what resolves:
   - `https://nbatopshot.com/drop/6739`
   - `https://nbatopshot.com/packs/6739`
   - `https://nbatopshot.com/listings/p2p?distId=6739`
   - `https://nbatopshot.com/pack/2d5b6510-f50a-40b2-9dcb-0c2a3ca9ce84`

2. Encode the winner into `lib/pack-urls.ts`:

```ts
export function topshotPackUrl({ distId, packListingUuid }: {
  distId: string
  packListingUuid: string | null
}): string {
  return `https://nbatopshot.com/drop/${distId}` // replace with verified pattern
}
```

3. Update `app/(collections)/[collection]/pack/dist/[distId]/page.tsx` (~line 444 in the original audit; line may have shifted after the Phase §1 fix), the simulator page, and any other surface that constructs TS pack URLs to call the helper.

---

## Phase 5 — Player / Series / Set polish

### What to do

1. Add `loading.tsx` to `app/(collections)/[collection]/player/[slug]/` and `app/(collections)/[collection]/team/[slug]/` — mirror the structure of `app/(collections)/[collection]/edition/[slug]/loading.tsx`.

2. Tokenize the lone hardcoded font at `app/(collections)/[collection]/series/[slug]/page.tsx:151` — `fontFamily: "'Share Tech Mono', monospace"` → `fontFamily: "var(--font-mono)"`.

3. New RPC `get_player_recent_sales(p_player_id uuid, p_limit int)` returning the same columns as moment-page sales (with buyer/seller). Render at the bottom of the player page as "Recent Sales (15)" using the same component as moment.

4. Add "TOP MOMENTS BY FMV" grid to series page (between stats and Sets) — 25 cards via a simple `editions JOIN fmv_snapshots ORDER BY fmv_usd DESC LIMIT 25` direct query.

5. Add "TOP MOMENTS BY FMV" + "FLOOR LEADERS" mini-grids to set page.

6. New RPC `get_set_tier_mix(p_set_id uuid) RETURNS TABLE(tier text, n int)` to replace the 100-edition sample for the Tier Mix bar.

---

## Phase 6 — Verification & smoke

Run after each phase, and a final pass at the end.

### Per-phase smoke

- **Phase 1**: Avdija Fresh Threads 2024-10-24 renders Team = Portland Trail Blazers. TS editions count ≈ 9,139. `health_check()` clean.
- **Phase 2**: Moment page renders Buyer/Seller columns, Best Offer cell, Badges row, Parallels section, Special-serial pills, info bar in body with correct Team.
- **Phase 3**: `/nba-top-shot/sniper` and `/nfl-all-day/sniper` each show ≥ 50 deal rows. `/nba-top-shot/market` and `/nfl-all-day/market` show ≥ 50 listing rows. `tsCount` log line in `/api/sniper-feed` is > 0.
- **Phase 4**: Clicking BUY ON TOP SHOT on `/nba-top-shot/pack/dist/6739` opens a working TS URL (200 response).
- **Phase 5**: All 5 page types have loading.tsx skeletons. Player / Series / Set each have at least one new drill-down element.

### Final pass

- `SELECT array_agg(tablename) FROM pg_tables WHERE schemaname='public' AND rowsecurity=false` returns 0 rows (no RLS regression).
- `SELECT * FROM get_pipeline_alerts()` clean (no new red).
- Sentry org `rip-packs-city` project `javascript-nextjs` (per memory `sentry-config`) — zero new high-frequency errors after 6h.

---

## Constraints (read before starting)

- Work direct-to-`main`. No feature branches, no PRs (CLAUDE.md).
- Do NOT reintroduce the cart / in-app buy (memory `intelligence-first-decision`).
- Do NOT mention or prioritize the Pro paywall (memory `no-paywall-until-traction`).
- Do NOT reach out to Austin Kline / Flowty (memory `no-austin-kline-outreach`).
- `pipeline_runs` columns: `started_at`/`finished_at` are NOT NULL; `duration_ms` is GENERATED — never write it (memory `pipeline-runs-crash-logger`).
- A function exported from `'use client'` cannot be CALLED from a server component — it can only be JSX-rendered. If you see `Attempted to call <fn>…` truncated in Vercel logs, suspect this (memory `rsc-client-function-call-crash`).
- Cowork Glob/Grep without an explicit path searches scratchpad, not the repo — always pass `path=C:\Users\TDill\rip-packs-city` (memory `cowork-glob-grep-default-dir`).
- After each migration, count(*) before destructive ops (memory `verify-rowcount-before-destructive-db-ops`).
- Verify DB end-state, not the pipeline ack (memory `rpc-silent-failure-class`).

---

## Reference

- Original audit: `docs/handoff-2026-05-26-entity-pages-and-feeds.md` — sections §2-§7 contain the full DB shape, migration body, RPC bodies, and acceptance criteria. This new prompt is the work list; that one is the spec.
- Pack-dist fix commit chain (for posterity / pattern reuse): `64ea9ae` → `5d3bb33` → `59069a2` → `8b3d911` → `97e6c0d` → `7f493b2` (the actual fix).

End. Ship Phase 0 first.
