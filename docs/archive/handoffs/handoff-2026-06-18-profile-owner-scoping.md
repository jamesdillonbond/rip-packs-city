# Handoff 2026-06-18 — Profile cards: owner-scope holdings, keep spend private

Plain text, iPhone-pasteable. Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual file shape.

## Context

Follow-up to handoff-2026-06-18-profile-data-bugs.md (the ~4x over-count dedupe shipped in 80100c1). That fix made the numbers correct, but Item 4 there flagged the deeper issue: the profile holdings cards are VIEWER-scoped — the routes call getCurrentUser() and ignore the ownerKey the client already passes — so on a public profile a non-owner sees empty cards (anon) or the viewer's own data, and "Top Movers" reads empty.

Trevor's decision (2026-06-18): PUBLIC HOLDINGS, PRIVATE SPEND. Owner-scope the holdings cards so a public profile shows the profile OWNER's real holdings; keep cost-basis "Total Spent" / P/L owner-only (render only when you view your own profile). This matches the existing "Net P/L own-view-only" principle.

Key fact: the client ALREADY passes the identity. In app/profile/[username]/ProfileClient.tsx: CollectionBreakdownCard ownerKey={username}, TopMoversCard ownerKey={username}, CostBasisCard ownerKey={username} ownView={isOwnProfile} (isOwnProfile = myUsername.toLowerCase() === username.toLowerCase()). The routes just don't use ownerKey. There is already a public ownerKey→owner resolver pattern to copy.

The resolver (copy it): app/api/profile/teams/route.ts lines 19-30 —
  async function resolveUserId(ownerKey): looks up profile_bio .ilike("username", ownerKey) .maybeSingle() → user_id.
/api/profile/portfolio-history and /api/profile/teams are already PUBLIC ownerKey-driven endpoints using this; mirror them.

Current prod: the 3 commits from today are live (80100c1 profile dedupe, dd7e2bf AllDay+dispatcher, 8b3ef38 docs).

## Item 1 — collection-breakdown: owner-scope + public

File: app/api/profile/collection-breakdown/route.ts (+ the CollectionBreakdownCard component that fetches it)
Change: accept ?ownerKey=<username>. If present, resolveUserId(ownerKey) → ownerId and use that for get_user_saved_wallets(ownerId) instead of getCurrentUser().id; drop the auth gate for the ownerKey path (holdings are public on a showcase profile). Keep the addrs dedupe already shipped. If no ownerKey is passed, you may keep the existing getCurrentUser() behavior for the dashboard's own-view use, or standardize on ownerKey — your call, but the profile page must pass ownerKey.
Client: CollectionBreakdownCard must forward ownerKey to the fetch — fetch("/api/profile/collection-breakdown?ownerKey=" + encodeURIComponent(ownerKey)).
Verify: logged OUT, /profile/jamesdillonbond breakdown shows ~18,177 total (TS ~14,523 / AllDay ~3,705 / Pinnacle ~181 / Golazos ~44), FMV ~$94K.

## Item 2 — top-movers: owner-scope + public (also fixes the empty section)

File: app/api/profile/top-movers/route.ts (+ TopMoversCard)
Change: same ownerKey treatment — resolveUserId(ownerKey) → ownerId → get_user_saved_wallets(ownerId); make the ownerKey path public. The route already dedupes movers by edition_id, so no count bug; the ONLY reason Top Movers renders empty on a public profile is the viewer-scope (anon → getCurrentUser null → no wallets). Owner-scoping fixes it. (get_top_movers is verified working: for 0xbd94…cade it returns 5 gainers / 5 losers.)
Client: TopMoversCard forwards ownerKey to the fetch.
Verify: logged OUT, /profile/jamesdillonbond Top Movers shows gainers (LeBron, Sabonis, Durant…) and losers.

## Item 3 — tier-breakdown: same ownerKey treatment (consistency)

File: app/api/profile/tier-breakdown/route.ts (+ its card if the profile renders it)
Change: same ownerKey resolve. Apply for consistency so any tier card on the public profile is owner-scoped. Harmless if the profile doesn't currently render it (it's also used on the dashboard own-view, which can keep passing its own ownerKey or omit it).

## Item 4 — cost-basis-summary: KEEP owner-only (private spend)

File: app/api/profile/cost-basis-summary/route.ts (+ CostBasisCard)
Change: do NOT make this public. Keep the route getCurrentUser()-scoped (it returns the logged-in user's own cost basis — correct, since it only renders on own-view). The cost-basis dedupe is already shipped (80100c1). The gate: CostBasisCard already receives ownView={isOwnProfile} — ensure it only FETCHES and RENDERS when ownView is true, so a non-owner (or anon) viewing the profile never triggers it and never sees "Total Spent"/P/L. Defense-in-depth: the route requiring auth already prevents anon reads; the ownView gate prevents a logged-in non-owner from seeing their OWN spend mislabeled on someone else's profile.
Verify: logged OUT or as a different user, /profile/jamesdillonbond shows NO cost-basis/P-L card. Logged in AS jamesdillonbond, your own profile additionally shows the (correct, deduped) cost-basis card.

## Security / privacy note

Making collection-breakdown / top-movers / tier-breakdown public (ownerKey-driven) exposes a profile owner's HOLDINGS (moment counts, FMV, top movers) — intended per Trevor's decision (a public collector showcase). It mirrors the already-public /api/profile/teams + /api/profile/portfolio-history. No new RLS surface: resolveUserId reads profile_bio, then get_user_saved_wallets (SECDEF) runs via the service-role client just as teams does. Cost basis / P/L stays private (owner-only). After shipping, re-check check_public_security_invariants() and check_secdef_anon_execute_violations() = [] (should be unaffected — no DB change).

## Guardrails

- main only, no branches/PRs; PowerShell git commit; re-verify push with git rev-list --count origin/main..HEAD (expect 0).
- Route/.tsx only — no DB/RPC change.
- Log in CLAUDE.md + ledger.

## Expected end state

A logged-out visitor to /profile/<username> sees the owner's correct holdings (breakdown ~18,177, populated Top Movers, FMV ~$94K) and NO spend/P-L; the owner viewing their own profile additionally sees the deduped cost-basis/P-L card. Closes Item 4 of the profile-data-bugs handoff.
