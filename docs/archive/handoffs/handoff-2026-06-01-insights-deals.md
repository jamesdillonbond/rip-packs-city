# Handoff — new public surface /insights/deals (Below FMV)

Plain-text, iPhone-pasteable. No code fences. Sister of docs/handoff-2026-06-01-insights-offer-spread.md — same exact pattern (route + page + layout + OG + sitemap + index card, rpc-insights-qa checklisted). This doc gives only the DELTAS; for the shared mechanics (route skeleton, page clone of /insights/squeeze, layout canonical, OG clone, sitemap edit, index card, QA points) follow the offer-spread handoff.

CONTEXT — backing data already shipped live by Cowork (QA 1+2 DONE):
- View public.topshot_deals_vs_fmv (mig audit_20260601_topshot_deals_vs_fmv_view). security_invoker=on, anon SELECT-only; reads edition_offers (anon-readable, hardened earlier today) + editions + latest fmv_snapshots. check_public_security_invariants()=0.
- Definition: TS editions whose floor ask (edition_offers.low_ask) is below a HIGH/MEDIUM-confidence latest FMV. Gated low_ask>=5 + confidence IN (HIGH,MEDIUM) + low_ask<fmv so it's REAL discounts, not stale-FMV / penny-floor artifacts. Default ORDER BY discount_pct DESC.
- Columns: external_id, name, player_name, set_name, tier, circulation_count, fmv_usd, confidence, low_ask, discount_pct (= (fmv-ask)/fmv*100), discount_usd (= fmv-ask), ask_updated_at.
- Live shape: 120 rows (24 at >=25% off, 8 at >=40%). Curated/small by design (requires a real ask AND a trustworthy FMV AND ask<FMV). Sample: KD Constellations FMV $30.09 / ask $12.99 (57% off), Ja Morant Metallic Gold FMV $16.40 / ask $7.89 (52%), Steph Curry Metallic Gold FMV $59.88 / ask $33 (45%).
- WHY: this is the public, honest, top-of-funnel version of the (auth-gated) sniper — "what's underpriced right now" is the single most commercially-relevant collector signal, and the public /insights wedge is the distribution play while funnel is the bottleneck. No native Top Shot surface ranks listings against a confidence-rated FMV.

Prod: deploy READY past e246f22. GUARDRAILS as in the offer-spread handoff.

DELTAS vs the offer-spread handoff:

FILE 1 — app/api/public/insights/deals/route.ts
Same skeleton as the offer-spread route, but:
- .from("topshot_deals_vs_fmv")
- .select("external_id, name, player_name, set_name, tier, circulation_count, fmv_usd, confidence, low_ask, discount_pct, discount_usd, ask_updated_at")
- Params: tier (TS tiers, same validation); min_discount (default 0 so drill-downs never empty; the page board passes 10); confidence (optional "HIGH" or "MEDIUM" single filter; default both); set/player ilike; sort in {discount (default, discount_pct DESC), fmv (fmv_usd DESC), ask (low_ask ASC), circulation (circulation_count ASC)}; limit 1..200 default 50.
- Filter: q = q.gte("discount_pct", minDiscount); if (confidence) q = q.eq("confidence", confidence).
- source: "topshot_deals_vs_fmv". Cache s-maxage=300.

FILE 2 — app/insights/deals/page.tsx (clone /insights/squeeze)
- h1 "Below FMV"; sub (honest): "Top Shot editions listed below a trustworthy (HIGH/MEDIUM-confidence) FMV. A big gap can be a real steal — or a low-serial / stale listing. We show the FMV, its confidence, and the floor ask side by side so you can judge."
- KPI cards: total deals; # at >=25% off; median discount_pct; rows shown.
- Table columns: Player / Edition (link to /nba-top-shot/edition/<encodeURIComponent(external_id)>); Tier chip; FMV (fmv_usd) + a confidence chip (HIGH/MEDIUM); Floor ask (low_ask); Discount (discount_pct as a badge + discount_usd); Mint (circulation_count). WRAP the <table> in overflow-x:auto (the A4 mobile lesson — do it from day one).
- Board default: min_discount=10, sort=discount, limit=50. A tier dropdown + a confidence toggle (HIGH only). Player/set drill-downs send min_discount=0.
- Honest empty state; brand tokens only (SVG/OG hex exception).

FILE 3 — app/insights/deals/layout.tsx: canonical ${SITE}/insights/deals (param-stripped); title "Below FMV — Top Shot Deals vs Fair Value | Rip Packs City"; desc "Top Shot editions listed below a confidence-rated FMV — the public deals board."; WebApplication JSON-LD; OG image -> the route below.

FILE 4 — app/api/og/insights/deals/route.tsx: clone the market OG; headline e.g. "<N> Top Shot editions listed below FMV" + "Below FMV · RPC Insights".

FILE 5 — app/sitemap.ts: add 'deals' to INSIGHT_ROUTES (alongside 'offer-spread' from the sister handoff).

FILE 6 — app/insights/page.tsx: add a "Below FMV" card linking /insights/deals.

QA (rpc-insights-qa): 1 backing data DONE (120 rows). 2 security DONE (security_invoker, anon SELECT-only, invariants 0). 3 smoke route+page+OG after deploy. 4 sitemap (File 5). 5 param-stripped canonical (File 3). 6 drill-downs min_discount=0 default. 7 freshness: edition_offers (continuous) + fmv-recalc (daily) both fresh; honest empty state. 8 brand tokens.

POST-SHIP: smoke all insights surfaces; add topshot_deals_vs_fmv to the rpc-insights-health artifact surface list. Revert: delete the 4 new files + 2 edits (git revert); view can stay or DROP VIEW public.topshot_deals_vs_fmv.

END STATE: /insights/deals live + crawlable — a confidence-gated "what's underpriced right now" board, the public top-of-funnel counterpart to the sniper, honest about the FMV-vs-ask signal, mobile-safe from day one.
