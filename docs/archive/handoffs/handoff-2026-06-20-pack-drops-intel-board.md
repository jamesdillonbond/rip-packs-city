# Handoff — `/insights/pack-drops` intelligence board (Shape A, no custody)

**Date:** 2026-06-20
**From:** Cowork investigation (see `docs/strategy/repack-drops-feature-scope-2026-06-19.md`)
**For:** Claude Code (Cowork can't push routes/.tsx)
**Risk:** LOW — read-only public insights surface, zero custody, zero inventory. No FMV-writer/pricing-logic changes. Touches a new route + page + OG + one additive read-only RPC.

## Why

Vaultopolis sells curated "re-packs" of real Top Shot moments (`vaultopolis.com/early-access/N`) priced in FLOW. Their composition/odds/sale-state are served from an **open, unauthenticated API**. RPC can index any drop and score it against **RPC FMV** — an "is this drop worth it?" board that no native surface offers and that draws their buyers to RPC. This is the low-risk wedge from the scope doc (Shape A); it does NOT commit RPC to minting/holding packs (Shape B).

**Proven on live data 2026-06-20:** for drop #4 RPC auto-priced 13/14 distinct editions; RPC pool $123.85 vs their $104.17; RPC pack EV $8.26 vs $4.79 price. RPC even caught their OG Anunoby rare underpriced ($17 vs their $8.50). Only gap: RPC undervalues the Wemby *parallel* chase (edition-level FMV, not subedition) — flag it, don't hide it.

## Data sources

1. **Vaultopolis public API** (no auth, fetch server-side, cache ~15 min):
   - `https://data.vaultopolis.com/api/drops/{id}/composition` → `{dropId,name,displayName,description,packCount,nftsPerPack,totalNfts,openedCount,status,assets:{TopShot:[{nftId,playerName,setName,series,serialNumber,momentCount,tier,valueTier,estimatedValue,floorPrice,parallel,subeditionId}]}}`
   - `.../odds` → `{slotTemplate,tiers:[{tier,count,perCardProb,perPackAtLeastOne}],hitRate,publishedAt,methodology,disclaimer}`
   - `.../sale-state` → `{listed,sold,total,saleOpen,soldOut}`
   - Drop discovery: ids are sequential ints. Probe `1..N` until composition 404s; cache the live set. (No list endpoint exists.)
2. **RPC FMV** — match each moment to a canonical TS edition and read latest `fmv_snapshots`.

## Matching (validated — 13/14 on drop #4)

Match Vaultopolis moments to RPC editions on `player_name ILIKE` + `set_name ILIKE` + `series` (Vaultopolis `series` is the on-chain int, same as `editions.series`). Always filter canonical: `editions.external_id ~ '^[0-9]+:[0-9]+$'` and `collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'`.

Known limitations (surface them in the UI, don't paper over):
- **Parallels/subeditions** (`parallel:true` / `subeditionId`) price at the *base* edition level today → RPC undervalues chases. Tag these rows "edition-level (parallel premium not yet priced)". Upgrade path = RPC's serial-/parallel-FMV layer.
- A name/set mismatch can miss an edition (1/14 on #4: "De'Aaron Fox / Base Set / S0"). Show matched-count honestly ("priced 13/14").
- Exact upgrade later: resolve each `nftId` → `setID:playID` via the topshot-proxy for an exact edition key instead of name-matching.

## Backing RPC (additive migration)

Wrap the proven pricing join in a SECDEF, service_role-only RPC so the route passes a small JSON of editions and gets RPC FMV back. **Follow the `rpc-migration` skill** (grants reset on CREATE OR REPLACE → revoke from anon/authenticated; service_role + postgres only).

`get_pack_drop_pricing(p_eds jsonb)` where `p_eds` = `[{"player":..,"set":..,"series":..}]`, returns one row per input with `rpc_fmv_avg, rpc_fmv_min, rpc_fmv_max, confidence, edition_matches`. Core query (validated; adapt to read from the jsonb input via `jsonb_to_recordset`):

```sql
-- per-edition latest FMV via LATERAL (uses idx_fmv_edition_time; do NOT DISTINCT-ON all of fmv_snapshots)
SELECT d.player, d.setname, d.series,
       COUNT(e.id) AS edition_matches,
       AVG(lf.fmv_usd)  AS rpc_fmv_avg,
       MIN(lf.fmv_usd)  AS rpc_fmv_min,
       MAX(lf.fmv_usd)  AS rpc_fmv_max,
       MAX(lf.confidence::text) AS confidence
FROM jsonb_to_recordset(p_eds) AS d(player text, setname text, series int)
LEFT JOIN editions e
  ON e.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
 AND e.external_id ~ '^[0-9]+:[0-9]+$'
 AND e.player_name ILIKE d.player
 AND e.set_name   ILIKE d.setname
 AND e.series      = d.series
LEFT JOIN LATERAL (
  SELECT fmv_usd, confidence FROM fmv_snapshots fs
  WHERE fs.edition_id = e.id ORDER BY computed_at DESC LIMIT 1
) lf ON true
GROUP BY d.player, d.setname, d.series;
```

Revert: `DROP FUNCTION public.get_pack_drop_pricing(jsonb);`

## Files

- `app/api/public/insights/pack-drops/route.ts` — server: discover drops, fetch composition/odds/sale-state, roll moments to distinct (player,set,series), call `get_pack_drop_pricing`, compute **RPC pool = Σ rpc_fmv×n** (fallback to their `estimatedValue` on a miss), **RPC pack EV = pool / packCount**, value-concentration (% of pool in top edition), and a verdict vs the FLOW price. `Cache-Control: s-maxage=900`. Under the existing `/api/public/*` allowlist.
- `app/insights/pack-drops/page.tsx` (+ metadata-only `layout.tsx`) — per drop: header (name, packs sold/left, FLOW price + ~USD), the **RPC-vs-operator** table (player·set·serial·their value-tier·their est·**RPC FMV**·confidence·matched?), EV verdict line ("RPC values this pack at ~$X vs $Y to buy"), odds table, honest caveats (parallel-premium gap, matched N/total). Brand tokens only (`var(--rpc-red)`, `var(--font-display)`, `var(--font-mono)`); `MobileNav` + chrome; honest empty state.
- `app/api/og/insights/pack-drops/route.tsx` — 1200×630 OG (mirror an existing insights OG; the 3 hardcoded `#E03A2F` in OG routes are the universal Satori exception).
- `app/sitemap.ts` — add `pack-drops`.
- `proxy.ts` — `/insights/pack-drops` is already covered by the `/insights/*` anon-public rule; confirm. The API is covered by `/api/public/*`. No new carve-out expected.

## QA before ship (run the `rpc-insights-qa` checklist)

Backing RPC service_role-only + `check_secdef_anon_execute_violations()` = []; `check_public_security_invariants()` = 0; route under `/api/public/*`; sitemap + param-stripped self-canonical; OG 1200×630 + WebApplication JSON-LD; 15-min ISR; brand tokens (0 hardcoded `#E03A2F` outside the OG route); honest empty state + "priced N/total" + parallel caveat; anon HTTP 200 live. Smoke: drop #4 should reproduce RPC pool ≈ $123.85 / pack EV ≈ $8.26 / 13-of-14 matched.

## Notes / non-goals

- Read-only. No `pack_drops`/inventory tables, no contract — that's Shape B (separate, gated, see scope doc §4/§6).
- Don't "fix" the parallel-chase undervaluation by hand — it's the serial-FMV layer's job; just label it.
- Cron/freshness: a daily reconcile that snapshots sale-through per drop would feed a future "how Vaultopolis drops actually sell" board, but is optional for v1.

Revert whole feature: `git revert <commit>` + `DROP FUNCTION public.get_pack_drop_pricing(jsonb);`.
