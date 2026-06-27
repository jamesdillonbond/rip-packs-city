# Handoff 2026-06-09 — tetrisLblock feedback: burned-moment verify target + collection-page holo shimmer glitch

## Context

Two user-reported bugs from beta user tetrisLblock (Discord, 2026-06-09). Nothing was shipped by Cowork for these — both fixes are route/.tsx/css code, so the entire job is this handoff. Root causes were verified against the working tree at HEAD 15ca791 (feat(packs): dapper.market pack-browse link). No collision with the overnight ledger: the verify-challenge mint flow last changed in b569b56 (2026-06-07, cold-wallet fallback) and the 2026-06-08 HybridCustody verify-link path is a separate route.

Bug A: the wallet-verification listing challenge picked a BURNED moment (Paul Millsap, Base Set, serial 37562) and asked him to list it for $10.90 — impossible, he doesn't hold it anymore.

Bug B: his collection page "goes bananas" — full-viewport purple/blue diagonal stripes cycling to the left.

Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape.

## Item 1 (HIGH) — verify-challenge can target moments the wallet no longer holds (burned/transferred)

File: app/api/profile/verify-challenge/route.ts (verified exists; the picker is pickCandidates ~L63 and the candidate confirm loop ~L168-180).
Helper (read, no change required): lib/verify-wallet-gql.ts.

Root cause. pickCandidates reads wallet_moments_cache (via pick_verification_target RPC, with a raw wmc fallback), and wmc is a CACHE — it keeps rows for moments the wallet burned or transferred until the next backfill walk. The per-candidate live confirm calls fetchMomentListingState (Top Shot GQL getMintedMoment) and accepts on found && !isLocked && !forSale — but getMintedMoment keeps returning the moment's metadata after a burn (found=true, not locked, not for sale), so a burned moment passes every check. Ownership is never verified anywhere in the mint path.

Fix. Add a single on-chain ownership gate to POST, between pickCandidates and the GQL confirm loop:

1. Fetch the wallet's live on-chain TopShot moment IDs ONCE via Flow REST executing a Cadence getIDs() script. Do NOT invent a new pattern — reuse the exact machinery already proven in lib/chains/flow/wallet-backfill-helpers.ts: FLOW_REST = https://rest-mainnet.onflow.org/v1/scripts (L34), POST to FLOW_REST?block_height=sealed (the L128 call shape), script base64 via Buffer.from(script, "utf8").toString("base64") (NEVER btoa — the CLAUDE.md Flow REST footgun), each argument Buffer.from(JSON.stringify({type:"Address", value: wallet}), "utf8").toString("base64"), response decoded atob/trim/strip-quotes then JSON.parse. The script body should mirror the existing TS getIDs walk in that same file (~L1301 region): import TopShot from 0x0b2a3299cc857e29; borrow &{TopShot.MomentCollectionPublic} at /public/MomentCollection; return col.getIDs(). getIDs() alone is cheap even at 40k+ moments per the helper's own comments. If a suitable exported helper already exists in wallet-backfill-helpers.ts, call it instead of duplicating the script.

2. Build a Set of the returned IDs as strings and filter candidates to those whose moment_id is in the set (wmc.moment_id for TS is the on-chain UInt64 id as text — same id space; that's why fetchMomentListingState already works with it).

3. Failure semantics: if the Cadence read throws or returns no collection (transient access-node error), log and FALL BACK to the current behavior (GQL-only checks) — a transient Flow hiccup must not dead-end verification. Only when the read SUCCEEDS does the ownership filter apply.

4. If the ownership filter eliminates ALL candidates (wmc is wholly stale for the cheap tail), fire-and-forget the existing wallet-backfill kick that already exists in this route's cold-wallet branch (~L134-151, Bearer INGEST_SECRET_TOKEN via after()), but with force=true semantics (POST /api/wallet-backfill?force=true) so the stale rows get re-walked, and return the existing unavailable shape with reason "indexing" and a message like: "Your collection cache looks out of date — we're refreshing it now. Try again in a few minutes." Do not silently fall through to a stale candidate.

Optional hardening, same commit if trivial: in verify-challenge/check, nothing changes — the check only confirms a live listing at the exact amount, which a burned moment can never produce, so the gate at mint time is sufficient.

Verification counts: pickCandidates has exactly 2 sources (RPC + relaxed wmc query, both in this one file — grep "pick_verification_target" returns only this route among app code). fetchMomentListingState callers: verify-challenge/route.ts and verify-challenge/check/route.ts only.

Revert path: git revert the commit. No DB change in this item.

Expected verification: npx tsc --noEmit clean; deploy READY; manual: POST /api/profile/verify-challenge for a wallet with known stale wmc rows picks only currently-held moments; smoke test stays 0 fails.

## Item 2 (HIGH, trivially small) — holo shimmer classes on table rows paint full-viewport animated gradients

Files: app/(collections)/[collection]/collection/page.tsx (the row className, verified at ~L2237) and app/rpc-tokens.css (holo block, L126-195).

Root cause. The collection table applies rpc-holo-legendary / rpc-holo-ultimate / rpc-holo-rare to the tr element. The holo CSS relies on position:relative + overflow:hidden on the host plus an ::after with position:absolute; inset:0. Per the CSS spec the effect of position:relative on table-row elements is UNDEFINED, and overflow:hidden does not clip on a tr — so in browsers/GPU paths where the tr does not become a containing block, each row's ::after resolves inset:0 against the page-level containing block: one full-viewport animated gradient PER tier row, stacked. rpc-holo-rare's gradient is rgba(129,140,248,…) — indigo/periwinkle, exactly the purple-blue stripes in the user's screenshot, and holoShimmer animates background-position, hence "colors cycle to the left". Every other surface that uses these classes (sniper cards, profile cards, dashboard cards) applies them to divs, which is why only the collection page misbehaves, and only for some users/browsers.

Fix, two parts:

(a) collection/page.tsx ~L2237: remove the three rpc-holo-* class branches from the tr className entirely, and instead apply the same tier-conditional class to the thumbnail wrapper div inside the first td (the div with className "relative shrink-0" style width 48 height 64, a few lines below). That div is a real block box with position:relative already — the shimmer renders correctly and the feature is kept. If wiring the class into that inner IIFE is awkward, simply dropping the holo classes from the collection page is also acceptable — correctness over flair.

(b) rpc-tokens.css: add a defensive guard so this bug class can never come back on any table anywhere:

tr[class*="rpc-holo-"]::after { content: none !important; }

Place it right after the rpc-holo-rare block (~L195). Optionally also add a prefers-reduced-motion guard while in the file:

@media (prefers-reduced-motion: reduce) { [class*="rpc-holo-"]::after { animation: none; } }

Revert path: git revert the commit (pure presentation, no data).

Expected verification: npx tsc --noEmit clean; deploy READY; manual: load /nba-top-shot/collection for a wallet holding Rare/Legendary/Ultimate moments — no full-page gradient; thumbnails of tier moments shimmer (if option (a) chosen). Ask tetrisLblock to confirm on his machine since the corruption was browser/GPU-dependent.

## Guardrails (repeat every handoff)

- Direct-to-main, no branches, no PRs. If a claude/* branch is pre-checked-out, switch to main first.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). Re-verify the push with git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration hard cap is 800s — anything higher sends the deploy to ERROR invisibly.
- CRLF: don't string-replace-patch on Windows; use full-file writes or findIndex on split lines.
- Flow REST args/scripts: Buffer.from(..., "utf8").toString("base64"), never btoa (Unicode crash — the exact P1-CAD incident class).
- Run the smoke test after deploy.

## End state

One or two commits on main, deploy READY: the listing challenge can only ever target a moment the wallet provably holds on-chain right now, and the collection page never paints row-level holo overlays at viewport scale.
