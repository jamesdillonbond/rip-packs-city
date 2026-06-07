# Handoff — profile OG card fix + share button + share quest — 2026-06-07

PLAIN TEXT (iPhone copy-paste). No triple-backticks. Claude Code's direct file inspection wins on any disagreement. Direct to main, no branches/PRs. Push anything pending first (explicit-path staging).

================================================================
CONTEXT
================================================================
Trevor wants profile links shared on X/Discord to unfurl the collection + trophy case, as a social growth driver + a rewards quest. The infrastructure exists and is wired correctly (app/profile/[username]/layout.tsx sets openGraph.images + twitter summary_large_image -> /api/og/profile/<username>), BUT the card renders HOLLOW — verified live 2026-06-07 on /api/og/profile/jamesdillonbond: $0 PORTFOLIO FMV, "—" MOMENTS, 0/6 TROPHY CASE, "NO TROPHIES PINNED", for a profile that is actually $94.2K / 18,177 / 6-of-6.

Root cause (grounded in app/api/og/profile/[username]/route.tsx ~L161-172): the route queries PostgREST with owner_key=eq. on saved_wallets and trophy_moments — but those tables are keyed by user_id (uuid) now; neither has owner_key. Those fetches fail/return empty and the card falls back to zeros. profile_achievements DOES still have owner_key, which is why the achievement dots render.

This is the hollow-data class of bug (see rpc-fabricated-data-landmines): a real user shares their profile and the unfurl undersells them to exactly the audience we want to impress.

Already shipped DB-side (Cowork): points_rules row 'share_profile' (+50, 1/day) seeded INACTIVE — Item 3 activates it.

================================================================
ITEM 1 (P0) — fix the OG card data: app/api/og/profile/[username]/route.tsx
================================================================
- Resolve the username to the user's uuid first (profile_bio?username=eq.<name>&select=user_id — the page itself resolves profiles this way; match its lookup), then query:
  saved_wallets?user_id=eq.<uuid>&select=cached_fmv,cached_moment_count,cached_badges&limit=10
  trophy_moments?user_id=eq.<uuid>&select=slot,player_name,thumbnail_url,tier&order=slot.asc&limit=6
  profile_achievements stays on owner_key ONLY if that's what the live table uses for this user (it rendered, so it works — but check whether owner_key here is the username or the uuid and keep consistent).
- Keep the existing layout (stats row + achievements + right-side trophy fan). With real data the fan should show the 6 trophy thumbnails with tier borders.
- Also pull equipped_border/equipped_banner (profile_bio) if cheap, to tint the avatar ring on the card — optional polish, skip if it bloats the route.
- CACHE NOTE: X/Discord cache unfurls by URL for hours-days. After deploy, validate with a cache-busted URL (?v=2) in Discord and the X card validator. Consider adding a low s-maxage (e.g. 3600) on the response if it currently sends long cache headers.
Verify: /api/og/profile/jamesdillonbond renders $94.2K / 18,177 / 6 / trophy fan visible. A profile with no data still renders the graceful empty card.
Revert: git revert (single file).

================================================================
ITEM 2 (P1) — Share button (own profile + /rewards)
================================================================
- On the profile page when viewing YOUR OWN profile (session user matches), and as a small block on /rewards: a "Share your collection" affordance with two actions:
  (a) Share on X — open https://twitter.com/intent/tweet?text=<short copy>&url=<profile URL with ?utm_source=share&utm_medium=x> in a new tab.
  (b) Copy link — clipboard copy of the profile URL with ?utm_source=share&utm_medium=copy (works for Discord paste).
- Suggested copy (keep editable in one place): "My NBA Top Shot collection on @RipPacksCity — [FMV] across [N] Moments. [url]" — or simpler static copy; Trevor can tune. NO auto-posting anywhere; the user always completes the share themselves.
- The UTM params make inbound clicks attributable via the existing outbound/inbound instrumentation, so share->visit is measurable before any deeper analytics.

================================================================
ITEM 3 (P1) — the quest: award share_profile on the share action
================================================================
- Extend the HARDCODED allowlist in app/api/rewards/track/route.ts with { "share_profile": "share_profile" }. Same rules as view_squeeze: session-resolved user, no client action_key/amount, DB caps enforce 1/day +50.
- Fire the track call when the user clicks Share-on-X or Copy-link (the share ACTION is what we reward — a posted tweet can't be verified without X API access; the 1/day cap bounds farming to 50/day which the global cap also covers).
- POST-DEPLOY ACTIVATION (only after Items 2+3 are live): UPDATE points_rules SET active=true, updated_at=now() WHERE action_key='share_profile';  — until then the rule stays hidden from the earn list by design.
Verify: click Share on X -> intent opens, +50 lands once (second click same day -> daily_cap_reached, no error surfaced to the user beyond a gentle "already earned today"); the earn shows in rpc-rewards-console.

================================================================
GUARDRAILS
================================================================
- tsc clean; deploy READY; explicit-path staging; no proxy.ts changes.
- The track endpoint stays allowlist-only — never accept arbitrary events.
- No public posting on the user's behalf, ever — intent links only (the user sends the tweet).

================================================================
END STATE
================================================================
Sharing an RPC profile on X/Discord unfurls a real flex: portfolio FMV, moment count, and the six-trophy fan. Users get +50/day for sharing, shares are UTM-attributable, and the loop (share -> unfurl -> visitor -> "Build your own profile" CTA at the bottom of every profile) becomes RPC's first organic acquisition surface — ready for whenever Trevor opens the cohort.
