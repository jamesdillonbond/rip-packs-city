# Handoff 2026-06-15 — Deepen the TS serial-FMV line onto more surfaces

Context. The per-serial #1/perfect estimate is live and validated (LiveToken-gated, public flag on). It renders today on TWO surfaces only: the moment page (get_moment_detail.serial_fmv) and trophy slabs (get_trophy_slab_data / _by_username). Trevor's call: deepen it onto the per-moment surfaces collectors actually browse, rather than port to AllDay (AllDay has only 30 #1 sales/180d — too thin for a trustworthy port; revisit later). This handoff is the result of mapping every candidate surface's backing RPC, security mode, and the one wrinkle each has. It's render-coupled (every new surface needs a .tsx change) and one case is security-sensitive, so it should ship as one reviewed unit with tsc + smoke.

HEAD at write time: origin/main = bfeab86. Nothing here is shipped yet.

---

Shared mechanics (read once, applies to every item)

The helper: public.serial_fmv_estimate(p_collection_id uuid, p_serial int, p_circulation int, p_tier text, p_edition_fmv numeric, p_confidence text) RETURNS jsonb. It is SECURITY DEFINER, EXECUTE granted to postgres + service_role ONLY, and reads the service-role-only serial_fmv_multipliers table. It is fully null-safe: returns NULL for any null/zero input, any non-HIGH/MEDIUM confidence, and any serial that isn't #1 or perfect-mint. On a hit it returns {estimate_usd, multiplier, serial_bucket, circ_band, basis, sample_size, label}. It is parameterized by collection_id, so passing the call surface's collection through means it auto-lights-up for AllDay later (returns NULL until AllDay multipliers exist).

Field name convention: expose it as serial_fmv on each moment row (matches get_moment_detail and the trophy slabs — the frontend already knows this shape).

Render: reuse the existing serial-line treatment from the moment page / TrophySlab (the "estimated #1 premium ≈ $X · 2.56× the edition FMV · hollow-ring guide indicator" line). In dense grids, render it as a compact secondary badge on the tile (not a full line) to avoid clutter — show it only when serial_fmv is non-null, which is already a tiny subset (#1/perfect on a HIGH/MEDIUM base). Never let it replace or sit above the edition FMV; it's a floored secondary estimate.

THE security wrinkle (only matters for INVOKER callers — Item 1): serial_fmv_estimate is service-role-only EXECUTE. SECURITY DEFINER callers (Items 2-4) run as owner and can call it as-is, no grant change. SECURITY INVOKER callers reached by anon (Item 1) cannot — they'd hit permission-denied and break anon loads. The fix is one grant (see Item 1), not converting the INVOKER fn to SECDEF (that would bypass RLS and leak buy_price / cost basis on public profiles — the exact leak guarded against on 2026-06-14).

After any grant change, the gate is: SELECT check_public_security_invariants(); and SELECT check_secdef_anon_execute_violations(); — both must still return [] (empty). If the violations check newly flags serial_fmv_estimate, stop and reassess rather than shipping.

---

Item 1 (highest reach) — Collection / portfolio grid + public-profile collection

Backing RPC: public.get_wallet_moments_with_fmv(text, text, int, int, text, int, text, uuid) — SECURITY INVOKER, EXECUTE for anon/authenticated/service_role. Rendered via app/api/collection-moments/route.ts (the in-app collection grid) and the same RPC powers the public profile collection list. It already selects per-moment confidence (the lf.confidence LATERAL) and circulation (e.circulation_count), so the estimate inputs are all in scope. It's paginated (LIMIT p_limit, default 100), so calling the estimate per page row is cheap.

Change (two parts):
1. Grant: GRANT EXECUTE ON FUNCTION public.serial_fmv_estimate(uuid,integer,integer,text,numeric,text) TO anon, authenticated; — safe because the function returns only the market-premium estimate that is ALREADY public via get_moment_detail on every moment page; it exposes no row from the multipliers table beyond the computed number. Verify the two security checks above stay [].
2. In get_wallet_moments_with_fmv, in the `sorted` CTE, change `SELECT f.*` to `SELECT f.*, public.serial_fmv_estimate(p_collection_id, f.serial_number, f.circulation_count, f.tier, f.fmv_usd, f.confidence) AS serial_fmv`. row_to_json(s) then carries serial_fmv automatically. Keep the same function signature (so grants are preserved), same SET search_path, same statement_timeout. This is byte-identical except the one added select expression. Pinnacle/AllDay rows return serial_fmv = null (no multipliers for those collections yet) — correct.

Do NOT convert this function to SECURITY DEFINER (cost-basis leak via buy_price).

Render: collection-grid tile + public-profile tile show the compact serial badge when moment.serial_fmv is present.

Revert: REVOKE EXECUTE ON FUNCTION public.serial_fmv_estimate(uuid,integer,integer,text,numeric,text) FROM anon, authenticated; and CREATE OR REPLACE get_wallet_moments_with_fmv back to the `SELECT f.*` form (current body is in git / queryable via pg_get_functiondef before you change it).

---

Item 2 — Dashboard "your top moments"

Backing RPC: public.get_user_top_owned_moments(uuid, int, text, uuid) (and the 3-arg overload) — SECURITY DEFINER, owner-only (has an auth.uid() cross-user guard), 8s statement_timeout, returns an explicit TABLE(...). Clean security (SECDEF calls the estimate as owner — no grant needed). Wrinkle: it returns wmc.fmv_usd but NOT confidence — and wmc has no confidence column (verified). So to gate the estimate you must source confidence per moment.

Change: add a LEFT JOIN LATERAL onto fmv_snapshots (latest-per-edition: WHERE fs.edition_id = e.id ORDER BY fs.computed_at DESC LIMIT 1) to pull confidence, then add a serial_fmv jsonb column to the RETURNS TABLE and to the final SELECT: public.serial_fmv_estimate(r.collection_id, r.serial_number, r.mint_count, r.tier, r.fmv_usd, <that confidence>). p_limit is ≤24, so the extra LATERAL is well within the 8s budget. Mirror the same change in the 3-arg overload (or have it delegate to the 4-arg). Keep SECDEF + search_path + the auth guard intact.

Note: this RPC reads wmc.fmv_usd (denormalized) while the estimate's multiplier was calibrated against fmv_snapshots edition FMV — they should match, but if you'd rather be exact, source edition_fmv from the same fmv_snapshots LATERAL you're adding for confidence.

Render: the dashboard top-moments cards show the serial badge on #1/perfect grails.

Revert: CREATE OR REPLACE both overloads back to their current bodies (queryable now via pg_get_functiondef).

---

Item 3 — Sniper deals (highest intelligence value, most code)

Surface: app/api/sniper-feed/route.ts (computeSniperFeed) — route-side logic over live TS listings; each deal is a specific listed moment with a serial + edition FMV. A listed #1/perfect priced against its serial estimate (vs the bare edition FMV) is a much sharper deal signal — this is the most differentiated use of the layer. Per-deal, so call the estimate for each deal's (serial, circulation, tier, edition_fmv, confidence). Since this is route code calling the DB, either (a) expose a thin batch RPC, or (b) call serial_fmv_estimate per deal through the service-role client (the route already uses service-role for FMV reads, so no anon-grant concern here). Render: show "est #1 premium $Y" alongside the edition FMV and compute the deal delta against it for #1/perfect listings.

Revert: git revert the route + render commit.

---

Item 4 (optional) — /share card

Backing RPC: public.get_wallet_collection_snapshot(text) — SECURITY DEFINER, anon-executable. If it returns per-moment rows carrying serial + circulation + tier + edition FMV + confidence, it's a clean SECDEF add (same as Item 2, no grant). Verify its shape first (pg_get_functiondef) — it may be an aggregate snapshot rather than per-moment, in which case skip it. The share card showing a grail's #1 premium is a nice viral touch but lowest priority.

---

Guardrails (standard)
- Direct-to-main, no branches, no PRs. If a claude/* branch is pre-checked-out, switch to main first.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). Re-verify push with git rev-list --count origin/main..HEAD (expect 0).
- These RPC edits go live via your migration path; run npx tsc --noEmit, confirm the Vercel deploy reaches READY, and that the collection-grid + dashboard smoke checks pass. Anon-load a public profile collection AFTER the Item 1 grant to confirm nothing broke.
- After the Item 1 grant: SELECT check_public_security_invariants(); and SELECT check_secdef_anon_execute_violations(); must both return [].
- Don't string-replace-patch on Windows (CRLF) — full-file writes.
- Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape (e.g. confirm the exact `sorted`-CTE line and the RETURNS TABLE column list before editing).

Expected end state: the validated #1/perfect serial line renders on the collection grid, public profiles, dashboard top-moments, and sniper deals — additive, floored at edition FMV, only on HIGH/MEDIUM #1/perfect moments — with security invariants still clean and no cost-basis leak. AllDay stays parked until it has the #1 sales density to support its own port.
