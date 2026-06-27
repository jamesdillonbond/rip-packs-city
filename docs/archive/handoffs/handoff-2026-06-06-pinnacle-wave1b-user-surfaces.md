# Wave 1b — render-keyed cutover of the Pinnacle user surfaces (PIN-FMV-REKEY-WAVES, wave 1 of 3)

GATE: ship after Trevor has eyeballed Wave 1a live (wmc per-render FMV — Dumbo card $8,734.07). This wave changes the public Pinnacle surfaces: the pin detail page, the scarcity board, and the edition-FMV RPC. Waves 2 (entity/team/cross-collection fns) and 3 (stats/health/analytics + routes) follow; legacy `pinnacle_fmv_snapshots` + writer retire only at zero readers (full inventory in docs/handoff-2026-06-06-pinnacle-per-render-fmv-VERDICT.md).

## Verified caller inventory (2026-06-06, grep + pg_catalog)

- `pinnacle_scarcity_board` (view) → exactly 3 consumers: app/insights/pinnacle-scarcity/page.tsx, PinnacleScarcityBoardClient.tsx, app/api/public/insights/pinnacle-scarcity/route.ts. One-deploy swap is feasible.
- `get_pinnacle_edition_fmv(p_edition_key)` → **ZERO repo callers** (grep app/lib *.ts/tsx). Orphaned. Build the render sibling, then retire it in wave 3 — no migration needed.
- Pin page app/pinnacle/moment/[id]/page.tsx → reads pinnacle_editions + pinnacle_fmv_snapshots directly; [id] = legacy edition_key; reached from scarcity-board row links (+ sitemap?). The real work of this wave.

## Item 1 (additive, ship first) — `get_pinnacle_render_fmv(p_render_id text)`

Single-row json from `pinnacle_catalog`: render_id, character_name, set_name, variant, printing, total_minted, fmv_usd, fmv_confidence, wap fields if stored, floor_ask, fmv computed_at. Mirror the legacy fn's shape where sensible so the pin page swap is mechanical. Grants: match the legacy fn's posture for whatever calls it server-side (service_role; do NOT default-PUBLIC — explicit REVOKE/GRANT per the secdef-regression rule).

## Item 2 — scarcity board re-key (view + page + API route in ONE deploy)

Rebuild `pinnacle_scarcity_board` on `pinnacle_catalog`: render_id (row key), character_name, set_name, variant, total_minted, scarcity_vs_variant_pct (variant avg from catalog total_minted), floor_ask, fmv_usd, fmv_confidence, image_url = '/api/public/pinnacle-image/' || render_id. Keep the view name + security posture (it's the public insights surface — match current grants/security_invoker). Coordinate the 3 consumers in the same deploy (column names shift: edition_id → render_id, ask_price → floor_ask, thumbnail via proxy path).

PRODUCT CALLS (Trevor):
1. Row count goes ~480 → ~2,079 per-render rows — richer board, but check the page's initial-rows cap / pagination / filters hold up.
2. Row links point at the re-keyed pin page (item 3) — decide the URL key first.
3. The board gains REAL images platform-wide via the proxy route (it currently surfaces pinnacle_editions.thumbnail_url, the placeholder-infested column) — visual QA the grid.

## Item 3 — pin page re-key (the substantive piece)

- Canonical key: RECOMMEND render_id in the URL (`/pinnacle/moment/LEV1-TREA-SPIN-S6`) — human-readable, matches catalog PK and the image proxy. (Alternative: Dapper's numeric edition_id, which aligns with disneypinnacle.com/pin/{id} — but render_id is already our spine.)
- Data: identity + art (proxy route) + floor_ask + fmv_* from pinnacle_catalog; sales history from pinnacle_sales WHERE render_id=...; serials where limited_edition. FMV-vs-floor display: where fmv >> floor_ask (>1.3x) show both (the Spinning Wheel pattern) — this page is where that lands first.
- Legacy URLs (`/pinnacle/moment/<edition_key>`): PRODUCT CALL — (a) RECOMMENDED: disambiguation view listing that key's renders (honest, preserves old links/sitemap), or (b) 301 to the key's highest-FMV render. Update sitemap to render-keyed URLs either way; keep OG/JSON-LD consistent (og image can use the proxy route).
- Spot-verify after ship: Kylo Ren DD page (render OEV1-SWHM-KYLO-S5) shows $277.67, its real art, 23 sales; set-mates show $23–33; legacy URL path behaves per the chosen option.

## Guardrails

- View + page + API route move in ONE deploy (the column shifts break each other if split). Item 1 can land any time before.
- Don't touch legacy tables/writers — they serve waves 2/3 readers until those migrate.
- Per-render confidence on thin renders reads lower than the old blend — correct; don't loosen gates.
- tsc clean, smoke green, direct-to-main, revert per item (`git revert` + restore prior view body — capture `pg_get_viewdef` pre-swap into the migration comment).

## End state

The public Pinnacle journey (insights board → pin page) runs entirely on the render spine: real art, per-pin FMV + floor, honest confidence — the first user-visible payoff of the re-key beyond wallet totals.
