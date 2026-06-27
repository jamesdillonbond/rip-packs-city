HANDOFF — Rookies board + RPC Index + wallet-paste onboarding (route/page/OG)
Date 2026-05-31 (Cowork). Two backing views shipped LIVE + verified this session; this packages the code half (routes + pages + OG + sitemap + canonical) that Cowork can't push. Mirror the existing /insights/squeeze + /insights/pack-reality surfaces exactly. Your file inspection wins over this doc.

GUARDRAILS: direct to main, no branches/PRs; PowerShell git + verify push (git rev-list --count origin/main..HEAD = 0); no CRLF string-replace patches (full-file writes); npx tsc --noEmit clean before push. After ship, run the /insights QA pass (security_invoker, route+page+OG 200, sitemap, canonical, drill-down floor, brand tokens) and smoke all insights surfaces in one pass.

SHIPPED LIVE THIS SESSION (DB, verified — do NOT re-create):
- View `public.topshot_rookies_board` — migration `audit_20260531_topshot_rookies_board_view`. security_invoker=on, anon/auth/service SELECT. 1,245 rows (301 three-star, 99% with FMV). Revert: `DROP VIEW public.topshot_rookies_board;`
- View `public.topshot_market_index_daily` — migration `audit_20260531_topshot_market_index_daily_view`. security_invoker=on, anon/auth/service SELECT. 540 rows (120 days × tiers + ALL). Revert: `DROP VIEW public.topshot_market_index_daily;`
Both match the security model of the live squeeze/pack-reality views exactly (verified: reloptions=['security_invoker=on'], anon SELECT true). No security drift — `check_public_security_invariants()` still 0.

=====================================================================
ITEM 1 — /insights/rookies (Surface C, completes the trilogy)
=====================================================================
STATUS UPDATE 2026-05-31: SHIPPED by CC as Surface C (commits 48ab39c/f156fa9/efa5e94) using `topshot_2025_rookie_cohort_stats`/`_index`, NOT the `topshot_rookies_board` this handoff originally proposed. That orphaned view was therefore DROPPED (migration `audit_20260531_drop_orphaned_topshot_rookies_board`; 0 dependents verified; revert = re-apply `audit_20260531_topshot_rookies_board_view`). The rest of this ITEM 1 is historical. Do NOT reference `topshot_rookies_board` — it no longer exists.
ORIGINAL PROPOSAL (historical) — backing view `topshot_rookies_board`. Columns: edition_id, external_id, player_name, set_name, tier, season, team, is_three_star_rookie, has_rookie_mint, has_rookie_tag, is_debut, badge_score, circulation, locked, burned, lock_pct, burn_pct, squeeze_pct, effectively_buyable, low_ask, avg_sale_price, highest_offer, fmv_usd, confidence, game_date, thumbnail_url.
WHAT IT IS: Top Shot rookie editions (3-star rookie OR rookie-mint OR rookie play-tag; debut is a secondary `is_debut` flag, not a filter) with full squeeze metrics. The story: the scarcest rookie cards. Live top row (verified): Jalen Brunson "Run It Back: Origins" — 94.8% squeezed, 12 of 229 buyable, FMV $850. The "Run It Back: Origins" set is heavily locked (88–95%) — exactly the research's "Origins rookies 60–65% locked" thesis, sharper.
CODE (mirror /insights/squeeze 1:1):
- `app/api/public/insights/rookies/route.ts` — read `topshot_rookies_board` via the service-role client; support filters tier / set / rookie_type (three_star|rookie_mint|all) / min_squeeze / sort (squeeze_pct default, or badge_score, or fmv_usd) / limit; `Cache-Control: s-maxage=300` (badge_editions refreshes hourly, so 5m is safe — same as squeeze). Copy the squeeze route's shape.
- `app/(collections)/.../insights/rookies/page.tsx` (+ its `layout.tsx` for metadata/canonical) — board UI mirroring the squeeze page: rows with thumbnail, player/set, tier, rookie-type chips (3★ / RC mint), squeeze% bar, effectively_buyable, FMV+confidence; default sort squeeze_pct DESC; a rookie_type + tier + set filter. DRILL-DOWN FLOOR (checklist item 6): a `?set=` / `?player=` filter must pass `min_squeeze=0` so partial matches render instead of an empty page.
- OG: add `/api/og/insights-rookies` (or extend the shared insights OG) → 200 image/png, 1200×630, branded.
- Sitemap: add `/insights/rookies` to `app/sitemap.ts` (the squeeze + pack-reality entries are the template). The /insights wedge is the distribution thesis — crawlers must see it.
- Canonical: param-stripped self-canonical via the page's layout so `?set=`/`?player=` filtered URLs don't index as dupes.
- Brand: RPC tokens only (`var(--rpc-red)`, `var(--font-display)`, `var(--font-mono)`).
VERIFY: route 200 JSON; `/insights/rookies` renders for anon; OG 200; a `?set=Run%20It%20Back:%20Origins` drill-down renders rows; `rpc-insights-health` shows the rookies count after deploy.

=====================================================================
ITEM 2 — /insights/market  ("The RPC Index")
=====================================================================
BACKING VIEW (live): `topshot_market_index_daily`. Columns: d (date), tier ('ALL' | COMMON | FANDOM | RARE | LEGENDARY | ULTIMATE | UNKNOWN), sales, volume_usd, median_px, avg_px, max_px. 120 trailing days from real sales (price_usd>0).
WHAT IT IS: a tier-segmented daily market index. CRITICAL framing — the all-market median is sub-$1 (commons dominate by count: 450 of 550 daily sales), so DO NOT headline a single all-market price number; it's misleading (the same trap as face-value 200x EV). Segment by tier: live 2026-05-31 medians are LEGENDARY $58 / RARE $9 / FANDOM $3 / COMMON $0.50. The compelling headline is a NORMALIZED index per tier (frontend: index = median_px / median_px[base_day] * 100, base = earliest day in range) shown as a multi-line trend, plus a daily $-volume bar.
CODE:
- `app/api/public/insights/market/route.ts` — read `topshot_market_index_daily`; optional `tier` filter + `days` (default 120); `Cache-Control: s-maxage=900` (daily data, 15m fine). Return the per-tier daily series.
- `app/(collections)/.../insights/market/page.tsx` (+ layout) — a normalized multi-line index chart (one line per tier, base=100) + a volume bar; a headline card per tier showing current index value + % change vs 30d ago; honest note that it's secondary-sale medians, tier-segmented. (Slug `/insights/market` suggested; `/insights/index` also fine — your call. Headline copy: "The RPC Index".)
- OG: `/api/og/insights-market` → 200, branded, ideally rendering the LEGENDARY/RARE index lines.
- Sitemap + canonical: add `/insights/market` to `app/sitemap.ts`; param-stripped self-canonical.
- Brand tokens only.
NOTE (perf/honesty): the view re-aggregates 120d of sales on read; the API cache (s-maxage=900) keeps it cheap. If load warrants later, promote to a matview + daily refresh cron. Empty-tier days are simply absent (e.g. ULTIMATE rarely trades) — the chart should gap, not zero-fill misleadingly.
VERIFY: route 200; page renders the multi-line index for anon; OG 200; sitemap entry present.

=====================================================================
ITEM 3 — Wallet-paste onboarding (funnel/activation — NOT an API gap)
=====================================================================
FINDING: the anon wallet→value-moment path already exists end-to-end (verified in proxy.ts): `/api/wallet-search` (the marketing search box, exact-path public), `/api/collection-snapshot` (GET, wallet-keyed, public) backing `/share/<wallet>` (Total FMV + top moments, public; robots-disallowed so it's an activation surface, not SEO). So this is a UX/funnel build, not new plumbing.
SCOPE (CC):
- Front door: a prominent "Paste your Flow wallet → see your portfolio instantly (no login)" input on the home/landing page, routing to the value moment. (The P0 funnel fix already points the marketing CTA at the public /share; make it unmissable + above the fold.)
- The value moment: today /share shows Total FMV + top moments — that's parity with Top Shot's own profile. The DIFFERENTIATOR (the reason to use RPC) is showing their holdings through RPC's intelligence lens: "You hold N squeezed editions (>50% locked), R rookie cards, T trophies." That hook is what converts.
- Conversion CTA from the value moment: "Track this wallet / get deal + squeeze alerts → sign in."
DB ENABLER — SHIPPED LIVE + verified 2026-05-31 (migration `audit_20260531_get_wallet_intel_summary_rpc`): `get_wallet_intel_summary(p_wallet text) RETURNS jsonb`. SECDEF, `service_role` EXECUTE only (anon + authenticated EXECUTE = false, verified — must be called server-side). Self-contained from `wallet_moments_cache` + `editions` + `badge_editions` + `fmv_snapshots` (TS scope). Perf ~2.3s on the largest wallet (14,236 TS moments) → fine behind the route's cache (s-maxage); typical wallets are sub-second. Revert: `DROP FUNCTION public.get_wallet_intel_summary(text);`.
OUTPUT SHAPE: `{ wallet, ts_moments, ts_fmv, squeezed_count, rookie_count, trophy_count, highlights: [ { external_id, player_name, set_name, tier, serial_number, circulation, squeeze_pct, is_rookie, is_trophy, fmv_usd, confidence, thumbnail_url } × ≤6 ] }`. Definitions: squeezed = (locked+burned)/circulation > 50%; trophy = serial #1 OR 1-of-1; highlights ranked by decoration (squeezed+rookie+trophy) then squeeze_pct then FMV. Live samples (verified) — samwise222 (0xa3d67b29e104e701): 423 moments / $657 / 27 rookie / 7 squeezed / 0 trophy; Trevor (0xbd94…): 14,236 / $74,496 / 2,625 rookie / 831 squeezed / 20 trophy.
WIRE IT (CC): call this from the service-role-backed public `/share/<wallet>` data path (extend `collection-snapshot`, or add `/api/public/wallet-intel?wallet=`), and render the overlay on the value moment — "Your Top Shot intelligence: N rookies · M squeezed · T trophies" + a highlights strip (each linking to `/nba-top-shot/edition/<external_id>`). Anon cannot call the RPC directly (service_role only), so it must go through the server route, exactly like collection-snapshot. That completes Item 3's differentiator.
VERIFY: anon (logged-out) can paste a wallet on the landing page and reach a value moment with the intelligence overlay, no login wall; the CTA routes to sign-in.

=====================================================================
POST-SHIP (all items)
=====================================================================
- Smoke every /insights surface in one pass (routes + pages + OG) — the squeeze/pack-reality/rookies/market set.
- Add `topshot_rookies_board` and `topshot_market_index_daily` to the `rpc-insights-health` artifact's surface list so freshness/row-counts are monitored.
- Ledger: log the two shipped views + this handoff; mark the rookies/market surfaces "code pending CC".
REVERT: per-view DROP (above) for the data; `git revert` for the code.
