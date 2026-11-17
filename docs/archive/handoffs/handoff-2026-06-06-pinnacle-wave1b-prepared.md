# Wave 1b — PREPARED (item 1 shipped; items 2+3 HELD on the gate + product calls)

## Status

- **Item 1 — SHIPPED** (migration `audit_20260606_get_pinnacle_render_fmv`): `get_pinnacle_render_fmv(p_render_id text)` reads the per-render FMV home on `pinnacle_catalog` (render/character/set/variant/printing/total_minted/fmv_usd/wap/confidence/liquidity/sales counts/days_since_sale/floor_ask/algo/computed_at). service_role-only (PUBLIC/anon/authenticated revoked). Zero readers today — additive, gate-independent, as the handoff specified. Revert: `DROP FUNCTION public.get_pinnacle_render_fmv(text);`.
- **Items 2+3 — HELD.** Two reasons: (1) the handoff's own GATE ("ship after Trevor has eyeballed Wave 1a live") is not confirmed cleared — Trevor is away and said he'd eyeball the dashboard + /share when back; (2) these change PUBLIC surfaces + the pin-page URL scheme with SEO/sitemap consequences that aren't trivially revertible, and the handoff routes several decisions to Trevor as PRODUCT CALLs. Below is everything needed to ship them in one fast pass once Trevor confirms 1a + answers the product calls.

## PRODUCT CALLS Trevor must answer before items 2/3 ship

1. **Pin-page canonical URL key** — handoff RECOMMENDS `render_id` (`/pinnacle/moment/LEV1-TREA-SPIN-S6`): human-readable, matches the catalog PK + the image proxy. (Alt: Dapper numeric edition_id, aligns with disneypinnacle.com/pin/{id}.) This decides the scarcity-board row links AND the sitemap.
2. **Legacy `/pinnacle/moment/<edition_key>` URLs** — RECOMMENDED (a) a disambiguation view listing that key's renders (honest, preserves old links/sitemap); alt (b) 301 to the key's highest-FMV render.
3. **Scarcity board** goes ~480 → ~2,079 per-render rows — confirm the page's initial-rows cap / pagination / filters hold; visual-QA the grid now that it surfaces REAL images via the proxy route (was the placeholder-infested `pinnacle_editions.thumbnail_url`).

## Item 2 (scarcity board) — view + page + API route in ONE deploy

Consumers (verified grep): `app/insights/pinnacle-scarcity/page.tsx`, `components/.../PinnacleScarcityBoardClient.tsx`, `app/api/public/insights/pinnacle-scarcity/route.ts`. Column shifts: `edition_id → render_id`, `ask_price → floor_ask`, `thumbnail_url → image_url` (proxy path).

Prepared new view (rebuild on `pinnacle_catalog`; keep name + current security posture — it's the public insights surface):

```sql
CREATE OR REPLACE VIEW public.pinnacle_scarcity_board AS
WITH variant_avg AS (
  SELECT variant, avg(total_minted) AS variant_avg_mint
  FROM pinnacle_catalog WHERE total_minted IS NOT NULL GROUP BY variant
)
SELECT c.render_id,
       c.edition_id,
       c.character_name,
       c.franchises[1] AS franchise,
       c.set_name,
       c.variant AS variant_type,
       c.total_minted AS mint_count,
       c.is_chaser,
       c.floor_ask AS ask_price,
       va.variant_avg_mint,
       round(100.0 * (1 - c.total_minted::numeric / NULLIF(va.variant_avg_mint, 0)), 1) AS scarcity_vs_variant_pct,
       c.fmv_usd,
       c.fmv_confidence::text AS fmv_confidence,
       c.floor_ask,
       ('/api/public/pinnacle-image/' || c.render_id) AS image_url
FROM pinnacle_catalog c
LEFT JOIN variant_avg va ON va.variant = c.variant
WHERE c.total_minted IS NOT NULL AND c.set_name IS NOT NULL AND c.set_name <> 'Unknown' AND c.character_name IS NOT NULL;
```

(Adjust the consumers for the renamed columns + render_id row key + proxy image path in the same deploy. Re-apply the current grants/security_invoker after CREATE OR REPLACE — verify with `\dp pinnacle_scarcity_board` pre-swap; CREATE OR REPLACE VIEW preserves grants but confirm.)

### REVERT for item 2 (pre-swap viewdef captured verbatim 2026-06-06)

```sql
CREATE OR REPLACE VIEW public.pinnacle_scarcity_board AS
 WITH variant_avg AS (
         SELECT pinnacle_editions.variant_type,
            avg(pinnacle_editions.mint_count) AS variant_avg_mint
           FROM pinnacle_editions
          WHERE pinnacle_editions.mint_count IS NOT NULL
          GROUP BY pinnacle_editions.variant_type
        ), latest_fmv AS (
         SELECT DISTINCT ON (pinnacle_fmv_snapshots.edition_id) pinnacle_fmv_snapshots.edition_id,
            pinnacle_fmv_snapshots.fmv_usd,
            pinnacle_fmv_snapshots.confidence
           FROM pinnacle_fmv_snapshots
          ORDER BY pinnacle_fmv_snapshots.edition_id, pinnacle_fmv_snapshots.computed_at DESC
        )
 SELECT pe.id AS edition_id,
    pe.character_name,
    pe.franchise,
    pe.set_name,
    pe.variant_type,
    pe.mint_count,
    pe.is_chaser,
    pe.ask_price,
    va.variant_avg_mint,
    round(100.0 * (1::numeric - pe.mint_count::numeric / NULLIF(va.variant_avg_mint, 0::numeric)), 1) AS scarcity_vs_variant_pct,
    fs.fmv_usd,
    fs.confidence::text AS fmv_confidence,
    pe.thumbnail_url
   FROM pinnacle_editions pe
     LEFT JOIN variant_avg va ON va.variant_type = pe.variant_type
     LEFT JOIN latest_fmv fs ON fs.edition_id = pe.id
  WHERE pe.mint_count IS NOT NULL AND pe.set_name IS NOT NULL AND pe.set_name <> 'Unknown'::text AND pe.character_name IS NOT NULL;
```
(+ `git revert` the page/route commit.)

## Item 3 (pin page) — the substantive piece

`app/pinnacle/moment/[id]/page.tsx`: identity + art (`/api/public/pinnacle-image/<render_id>`) + floor_ask + fmv_* from `pinnacle_catalog` (via `get_pinnacle_render_fmv` or a direct read); sales history from `pinnacle_sales WHERE render_id = ...`; serials where limited_edition. FMV-vs-floor display where `fmv_usd > 1.3 * floor_ask` (the Spinning Wheel pattern lands here first). Legacy-URL handling per product call #2; update `sitemap.ts` to render-keyed URLs; keep OG/JSON-LD consistent (OG image can use the proxy route). Spot-verify: Kylo Ren DD (`OEV1-SWHM-KYLO-S5`) → $277.67, real art, 23 sales; set-mates $23–33.

## Guardrails (unchanged)

View + page + API route move in ONE deploy. Don't touch legacy tables/writers (waves 2/3 readers still use them). Don't loosen confidence gates. tsc clean, smoke green, direct-to-main, revert per item.
