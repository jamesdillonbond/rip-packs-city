# GO — Wave 1b items 2+3 (gate cleared, product calls decided)

Trevor answered the three blockers from docs/handoff-2026-06-06-pinnacle-wave1b-prepared.md on 2026-06-06 (~21:30Z, via Cowork). Ship items 2+3 in one coordinated deploy per the prepared doc.

## Decisions (final)

1. **Pin-page canonical URL key: `render_id`** — `/pinnacle/moment/<render_id>` (e.g. /pinnacle/moment/LEV1-TREA-SPIN-S6). The Dapper numeric stays available in data (`pinnacle_catalog.edition_id`) but is not the URL key.
2. **Legacy `/pinnacle/moment/<edition_key>` URLs: disambiguation page** — old links and sitemap entries render an honest list of that key's renders (art via the image proxy, each linking to its render-keyed page). No blind 301s. Migrate the sitemap to render-keyed URLs in the same ship.
3. **Gate: CONFIRMED** — Wave 1a eyeballed live and approved; the scarcity board going ~480 → ~2,079 per-render rows with proxy images is approved (visual-QA the grid as part of the ship).

## Notes from Cowork verification (already true in prod)

- Item 1 RPC `get_pinnacle_render_fmv` verified live: service_role-only acl; Kylo spot returns render_id/edition_id "2016"/identity/total_minted 101/fmv 277.5907 + floor — the pin page can consume it as-is.
- The FMV-vs-floor display lands here first: where fmv_usd >> floor_ask (>1.3x), show both (Spinning Wheel pattern: FMV $163.60 vs floor $185 now reads honest).
- Spot-checks after ship: Kylo DD render page (OEV1-SWHM-KYLO-S5) shows ~$277.59 + real art + 23 sales; set-mates $23–33; a legacy URL (e.g. STAR-OEV1-SWHM:Digital Display:1) renders the 12-helmet disambiguation list; board row links resolve; smoke green.

## Unchanged guardrails

View + page + API route in ONE deploy; capture pre-swap viewdef in the migration comment for revert; legacy tables/writers untouched (waves 2/3 still read them); tsc clean; direct-to-main.
