# Handoff — Wallet verification rebuild (on-demand listing-challenge check) — 2026-06-07

PLAIN TEXT (iPhone copy-paste). No triple-backticks. Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual file shape. Direct to main, no branches/PRs.

================================================================
STEP 0 — BEFORE ANYTHING ELSE: PUSH WHAT'S PENDING
================================================================
Trevor reports unpushed work sitting in VS Code. First action: git status; review what's uncommitted/unpushed; commit and push it (stage by EXPLICIT PATH — never git add -A; concurrent sessions may have work in the tree). Only then start the items below. After every push: git rev-list --count origin/main..HEAD must be 0.

================================================================
CONTEXT — why wallet verification is broken (verified 2026-06-07)
================================================================
1. "Sign in with Dapper" cannot work today: Dapper Wallet is an opt-in FCL wallet requiring a Dapper developer account, AND lib/chains/flow/fcl-config.ts points discovery.wallet at STANDARD discovery (fallback https://fcl-discovery.onflow.org/authn; NEXT_PUBLIC_FCL_DISCOVERY_WALLET unset) — so the popup offers Flow Wallet/Blocto, which don't custody Top Shot accounts. Leave the FCL button working (it's valid for self-custody users) but it is NOT the path for normal TS collectors. Trevor will request Dapper developer access separately.
2. The listing-challenge fallback exists and is the right mechanism, but its matcher is dead: resolve_wallet_verification_challenges() (called from app/api/topshot-listing-cache/route.ts ~L409-424) joins wallet_verification_challenges against cached_listings on storefront_address + exact ask_price — and cached_listings has been frozen since Flowty died (2026-05-13) / the TS listings indexer retired (2026-05-26). Lifetime record: 0 matches in 6 challenges, all resolved_via='expired' (4 of them Trevor's own attempts).
3. Already shipped live DB-side by Cowork today (no app work needed for these):
   - admin_verify_wallet(user_id, wallet, admin) — owner-attested interim verification; CHECK widened with 'owner_attested'; Trevor's wallet 0xbd94cade097e50ac is already attested (+500 link_wallet landed, he's Role Player).
   - resolve_wallet_challenge_match(p_challenge_id uuid, p_matched_moment_id text, p_source text default 'gql_on_demand') — SECDEF, service_role-only. Atomically: validates the challenge is unresolved+unexpired, marks it resolved, sets saved_wallets.verified_at (method 'listing_challenge'), and awards link_wallet (+500, idempotent). THE ROUTE MUST ONLY CALL THIS AFTER A CONFIRMED GQL MATCH — the route owns the truth check; the RPC trusts it.

THE INVARIANT: verification must remain proof-of-control. The on-demand check confirms via Top Shot's own API that the claimed wallet has a live listing at the exact challenge amount. Never resolve on client claims alone.

================================================================
AMENDMENT (2026-06-07, Trevor's UX feedback — READ FIRST, supersedes parts of Items 1-3)
================================================================
Trevor tried the flow; the friction was choosing what to list and finding it on Top Shot. New design: RPC PICKS THE MOMENT FOR THE USER and hands them a deep link. Flow becomes: open modal -> "List THIS Moment for exactly $X.YZ" (their own sub-$1 Moment shown as a card) -> [Open on Top Shot] -> they list it -> [Done — check] -> verified +500 -> "you can delist now."

Shipped live DB-side to support this (Cowork, audit_20260607_verification_target_picker):
- wallet_verification_challenges new columns: target_moment_id text, target_edition_key text, target_serial int, target_fmv numeric — the mint route stores the chosen target.
- pick_verification_target(p_wallet text, p_limit int default 5) — service_role-only; returns the wallet's cheapest displayable TS Moments (fmv_usd > 0 AND < 1, image present) as candidates: moment_id, edition_key, serial_number, player_name, set_name, image_url, fmv_usd. Verified on Trevor's wallet: returns $0.03-0.04 dust Commons.

Changes to the items below:
- MINT (POST /api/profile/verify-challenge): call pick_verification_target; live-confirm the top candidate via the per-moment GQL (unlocked + not already listed — skip to the next candidate if it fails; that same GQL query is the one the check uses); compute challenge_amount = GREATEST(round(fmv_usd*100), 10) + random cents (0.01-0.99, store 2dp — the cents are the uniqueness salt; the 100x/$10-floor price means it can never be unintentionally purchased); store amount + the target_* columns. Response includes the target card data + the exact price + a deep link to that Moment on Top Shot (ground the owned-moment URL format in the repo's existing native-moment URL builders — sniper-feed's resolveViewUrl fallback / the moment-page link helpers — do not guess it).
- CHECK (Item 1): becomes a SINGLE-MOMENT check — fetch the challenge's target_moment_id listing state via the per-moment GQL and compare list price to challenge_amount in cents. No wallet-scoped listing search needed; strategy (a) is dead, the amended (b) with a server-chosen moment is THE design. No user picker either.
- MODAL (Item 2): render the target Moment card (image/player/serial from the challenge response), the exact price in big type, [Open on Top Shot] (deep link, new tab), and [I've listed it — Done] -> check endpoint. On success: "Verified — +500 credits. You can delist the Moment now." On no-match: "Not seeing it yet — confirm it's listed at exactly $X.YZ and try again in a minute."
- Edge cases: picker returns empty (no sub-$1 Moment) -> relax: cheapest Moment overall, price = min(GREATEST(round(fmv*100),10), 999) + cents; wallet has no displayable Moments at all -> show "verification by listing unavailable for this wallet" (owner attestation or Dapper sign-in later are the fallbacks). Legacy challenges without target_* stay checkable only by expiry (ignore them; mint fresh).

================================================================
ITEM 1 (P0) — on-demand check endpoint: app/api/profile/verify-challenge/check/route.ts  [NEW]
================================================================
POST { wallet_addr } (and optionally { moment_id } — see strategy b). Session-resolved user (requireUser/getCurrentUser). Flow:
  1. Load the caller's ACTIVE challenge for that wallet (unresolved, unexpired) — same lookup the GET handler in app/api/profile/verify-challenge/route.ts uses (~L113-131). 404-style JSON if none.
  2. Query Top Shot for that wallet's CURRENT for-sale listings through the topshot-proxy worker (Cloudflare blocks direct egress — NEVER call public-api.nbatopshot.com directly; X-Proxy-Secret = TS_PROXY_SECRET).
     GQL grounding — do NOT invent query shapes; two acceptable strategies, in order of preference:
     (a) Wallet-scoped: a single query for the wallet's minted moments filtered to for-sale (the public API's searchMintedMoments-family with an owner/flow-address filter + forSale/listing fields). The authority for what actually works is the repo's own proven GQL: check workers/topshot-moments-hydrator (it reads per-moment listing state: is_listed / list_price) and the queries in app/api/sniper-feed + lib/chains/flow/topshot.ts. Test the candidate query live through the proxy before wiring it.
     (b) Moment-scoped fallback (no schema gamble, 1 call): require the user to tell us WHICH Moment they listed — extend the modal (Item 2) with a "which Moment?" picker fed from their wmc rows for that wallet (wallet_moments_cache where wallet_address = wallet, is cheap) or a pasted Top Shot moment link; then check THAT moment's listing state with the hydrator's per-moment query and compare list price to challenge_amount.
     Implement (a) if the API supports it cleanly; otherwise (b). Exact-match semantics: listing price equals challenge_amount (numeric, 2dp — compare as cents to avoid float drift).
  3. On match: const r = await supabaseAdmin.rpc("resolve_wallet_challenge_match", { p_challenge_id, p_matched_moment_id, p_source: "gql_on_demand" }) and return it (includes link_wallet_award — surface the +500 in the response).
  4. No match: return { matched:false } with a hint ("listing not visible yet — confirm the exact price $X.YZ and try again in ~1 min"). Rate-limit lightly (e.g., 6 checks/min per user) to keep GQL polite.
Revert: delete the route.

================================================================
ITEM 2 (P0) — dashboard modal: add "I've listed it — check now"
================================================================
File: app/dashboard/page.tsx (the verify-by-listing modal, ChallengeRow state ~L127-131, modal component ~L1492+; "Verify by listing" button ~L1278).
- Add a primary button in the modal: "I've listed it — check now" -> POST the Item-1 endpoint; on { ok:true } show success ("Wallet verified — +500 credits earned") and call the existing onVerified callback; on { matched:false } show the hint without closing.
- If strategy (b) was implemented, add the Moment picker to the modal (wmc-backed list: thumbnail + player + serial; or a paste field).
- Keep the existing challenge mint/expiry display as-is. The old cron resolver stays in place (harmless); this button is the live path.
Revert: remove the button/picker.

================================================================
ITEM 3 (P1) — repoint the /rewards Verify CTA off the dead path
================================================================
File: app/rewards/page.tsx (the verify banner + verified_wallet_required CTA from 5795518).
- Point the CTA at the dashboard verify-by-listing flow: link to /dashboard?verify=<their-wallet-or-1> and have app/dashboard/page.tsx open the verify modal when that param is present (it already tracks verifyWallet state ~L258 — wire the param to it; pick the user's saved wallet, or show the wallet list if several).
- Copy change: "Verify by listing a Moment — about 2 minutes" (drop any implication of Dapper sign-in). Leave the SignInWithDapper button where it lives for self-custody users, but the rewards path leads with the challenge flow.
Revert: restore the previous href/copy.

================================================================
ITEM 4 (P2, docs) — record it
================================================================
- docs/overnight/ledger.md (Shipped): wallet-verification rebuild — Dapper sign-in confirmed gated on Dapper developer access + config points at standard discovery; listing-challenge matcher was dead against frozen cached_listings (0/6 lifetime); rebuilt as on-demand GQL check (this commit) + DB resolver resolve_wallet_challenge_match + interim admin_verify_wallet/owner_attested (Cowork, audit_20260607_* migrations). Revert paths per item.
- CLAUDE.md Known issues: add a line — Dapper Wallet sign-in requires Dapper developer access (request pending, Trevor); FCL discovery is standard (Flow Wallet/Blocto) until then; wallet verification = listing challenge (on-demand check) or owner attestation.
Stage these two by explicit path.

================================================================
GUARDRAILS
================================================================
- Direct to main; PowerShell git; 0-ahead after push; tsc --noEmit clean; deploy READY.
- All TS GQL through topshot-proxy (X-Proxy-Secret) — Cloudflare blocks Vercel/direct egress.
- Supabase client typed as any; service-role only server-side; the resolver RPC is the ONLY write path for resolution (never UPDATE the tables directly from the route).
- Don't touch lib/chains/flow/fcl-config.ts semantics (Dapper enablement comes later, behind the developer-access grant + an env var).

================================================================
VERIFICATION (real end-to-end)
================================================================
- Trevor (already attested, so use a SECOND tester account or his alt): mint a challenge from the dashboard modal, list any cheap Moment on Top Shot at the exact challenge price, click "I've listed it — check now" -> verified + 500 credits land; rpc-rewards-console shows the link_wallet earn + verified method 'listing_challenge'. Delist the Moment after.
- Wrong-price listing -> { matched:false } hint, no resolution.
- Anon POST to the check endpoint -> 401/redirect. Resolver RPC remains non-executable by anon/authenticated (it is — verified at ship).
- /rewards banner now routes into the modal with the param flow.

================================================================
END STATE
================================================================
Pending work pushed first. Then: a Top Shot collector can verify wallet ownership in ~2 minutes with no Dapper approval needed — list at the challenge price, click check, verified, +500. The /rewards gate becomes a working onboarding step for everyone (not just owner-attested testers), unblocking Pro/Moment redemptions and referral payouts for the first cohort. Dapper sign-in remains a future upgrade behind Trevor's developer-access request.
