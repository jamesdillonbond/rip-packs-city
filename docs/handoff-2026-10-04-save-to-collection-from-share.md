# Handoff — "Save to my collection" on the public share page (logged-in viewers)

> ✅ **Item 1 SHIPPED 2026-10-04 ~9:20 AM PT (Claude Code, Trevor's box).** `app/share/[wallet]/SaveToCollectionCTA.tsx`, mounted next to `ShareButton`. It matches the dashboard's save paths (Flow → resolve-and-associate `{address}`; Candy → saved-wallets). Anonymous viewers see nothing. A wallet already on the account reads "In your collection — open dashboard →". A failed save blames the save, never the wallet; a 401 links to sign-in. Internal links use `next/link`, so the lint ratchet stays at 694. Funnel event skipped: `saved_wallets` already records each save, and a new event_type needs two allowlists plus the DB CHECK. Tests: `__tests__/component-SaveToCollectionCTA.test.tsx` (7; a planted defect showing the button to anon viewers fails the first). **Item 2 (welcome email for open-door signups) remains Trevor's call.**

**For:** Claude Code on Trevor's box (or a cloud session with the repo attached).
**Date:** 2026-10-04 (PT). **HEAD at authoring:** `3c99be280` ("chain arrivals seed: read purchases once, skip probed moments"), branch `main`.

> Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.

## Context

Nothing in this handoff is shipped yet — it is all route/`.tsx`, which Cowork does not push. No migration or edge-fn change is involved. The daily onboarding-funnel watch surfaced the first case live (2026-10-04): a new organic open-door signup (`serious.clearer@gmail.com`, user `1830d5fd-1a5b-4eb8-9f4b-3f52ea58f9c4`) signed up, logged in, then pasted their Top Shot username `foryoufrank_91` into the **home** wallet box, which resolved to Flow wallet `0xba14e24d976f8484` (fully warmed — 6,843 cached moments across 3 collections) and routed them to `/share/0xba14e24d976f8484`. They viewed their own collection there and left. `saved_wallets` stayed 0, so their `/dashboard` is empty. The resolve and the warm both worked; the only missing step was any way to attach that wallet to their account **from the page they were actually looking at**.

### Root cause (verified by file inspection)

- `components/WalletSearch.tsx` is the top-of-funnel wedge and **deliberately** routes every paste — anon or not — to the public `/share/<wallet>` (or `/insights/tc-report`). Its header comment makes the anon→public routing a do-not-regress rule ("bouncing the #1 CTA to /login is what killed this funnel"). So the home box is correctly not the place to save.
- The save path is `/api/profile/resolve-and-associate` (POST, auth-gated via `getCurrentUser`, 401 otherwise). It accepts **either** `{ username }` **or** `{ address }` (bare Flow cadence 0x+16hex), fans the wallet across all 5 published Flow surfaces (`SEED_SLUGS`), and warms it deep in `after()`. Today its only caller is `app/dashboard/DashboardClient.tsx` (`resolveAndAssociate`, ~line 655–730).
- `app/share/[wallet]/page.tsx` is a **server component** with **zero awareness of a logged-in viewer** (grep confirms: no `getCurrentUser`, no `saved_wallets`, no associate). It mounts client islands `FunnelTracker` (line 255), `DealWatchCapture` (298) and `ShareButton` (582). So a signed-in user on `/share/<their-wallet>` has no affordance to claim it.

**The gap, stated once:** a signed-in user viewing `/share/<wallet>` cannot attach that wallet to their account.

## Item 1 (primary) — signed-in "Save to my collection" island on the share page

**Files touched:**
- NEW: `app/share/[wallet]/SaveToCollectionCTA.tsx` (client island) — verify this path does not already exist before creating.
- EDIT: `app/share/[wallet]/page.tsx` — mount the new island next to the existing `<ShareButton wallet={wallet} />` at ~line 582. The page already imports `normalizeAddress` from `@/lib/address`, so no new server import is needed; just render `<SaveToCollectionCTA wallet={wallet} />` adjacent to `ShareButton`.

**Behavior (match the dashboard's existing logic exactly — do not invent new save semantics):**
1. On mount, resolve the browser Supabase client via `lib/auth/supabase-client.ts` (`createBrowserClient` singleton — grep for the exported accessor; the dashboard and `components/AnonSignInPill.tsx` / `components/TopNav.tsx` already use it) and check for a session. **Render nothing while unknown or signed-out** — anon viewers must see no change (preserves the public share card exactly).
2. When signed in, render a single button: "Save to my collection" (brand styling — follow `RPC_DESIGN_SYSTEM.md`; match `ShareButton`'s weight so the two sit together).
3. On click, branch on chain **exactly as `DashboardClient.resolveAndAssociate` does** (reuse `detectAddressChain` + `normalizeAddress` from `@/lib/address`, and `getPublishedCollection("candy-mlb")`):
   - `cadence` → POST `/api/profile/resolve-and-associate` with `{ address: normalizeAddress(wallet) }`
   - `solana` (base58 Candy) → POST `/api/profile/saved-wallets` with `{ walletAddr: normalizeAddress(wallet), collectionId: candy.supabaseCollectionId }`
   - otherwise (shouldn't happen — share `wallet` is already an address, never a username) → disable the button rather than calling the username path.
4. On success: a success state in-place ("Saved — indexing your moments…") plus a link to `/dashboard`. On 401 (session lapsed): link to `/login`. On other errors: the same honest "couldn't save just now, this says nothing about the wallet" tone the codebase uses — do not blame the wallet.

**Optional instrumentation (nice-to-have, additive):** fire a funnel event when a save happens from this surface so the lift is measurable. A new `event_type` requires adding it to BOTH allowlists — `lib/track-funnel.ts` (the union type) and `app/api/track-funnel/route.ts` (the runtime allow-set, ~line 16). Suggested `event_type: "wallet_saved"`, `surface: "share"`. If you'd rather not touch the allowlists in this change, skip the event; the save itself is observable via `saved_wallets`.

**Why this is the right surface, not the home box:** the user is already looking at the correct collection on the share page; one click converts the exact drop the watch caught. Touching `WalletSearch.tsx`'s routing instead would risk the documented anon-funnel regression.

**Revert:** `git revert` the commit (titled e.g. "share: signed-in viewers can save the wallet to their collection"); delete `SaveToCollectionCTA.tsx`. No DB or data revert — the endpoints already exist and are unchanged.

**Expected verification:** `npx tsc --noEmit` clean; lint ratchet unchanged; Vercel deploy READY. Smoke: signed-out `/share/0xba14e24d976f8484` renders identically to before (no new control); signed-in, the button appears and a click creates `saved_wallets` rows for that user across the Flow collections and warms them (watch Check 4/6 goes green for that user).

## Item 2 (secondary, flag for Trevor's call — not specified for immediate build)

Open-door signups get **no welcome email at all.** The welcome-email send (and Check 3's `welcome_email_error`) key off an `allow_list` row; open-door self-serve users have no `allow_list` row (front door opened 2026-07-20), so the entire approval→prewarm→welcome chain is skipped for them. For `serious.clearer@gmail.com` that means: no welcome, no nudge, and — until Item 1 ships — no in-product path from the share page back to their account. Worth deciding whether open-door first-login should trigger a lightweight "finish setting up — load your collection" email. This is a backend/edge change, larger scope, and needs Trevor's product call on copy/opt-in; not scoped here.

## Guardrails (repeat every handoff)

- **Direct to `main`, no branches, no PRs** (CLAUDE.md non-negotiable). If a `claude/*` branch is pre-checked-out, `git switch main` first.
- Commit via **PowerShell `git`** on Windows (Git Bash `git commit` can silently no-op). Re-verify the push with `git rev-list --count origin/main..HEAD` (expect 0).
- This no-push note is **specific to the Cowork cloud session** that wrote this. Trevor's machine and Claude Code push normally via Git Credential Manager / `gh auth setup-git`. ⛔ Never write the PAT into `remote.origin.pushurl` — that route is DEAD (PAT burned + removed 2026-08-16). Commit these files as usual.
- `curl` fails silently in Git Bash for Vercel REST — use PowerShell `Invoke-WebRequest` if you check the deploy.
- No `maxDuration` touched here (hard cap is 800s regardless).
- CRLF: write the new file whole; don't string-replace-patch on Windows.

## End state

One commit on `main` adding a signed-in-only "Save to my collection" island to `/share/[wallet]`, deploy READY, `tsc` clean. The next organic open-door signup who lands on their own share page can attach it in one click instead of bouncing off an empty dashboard — closing the drop the funnel watch caught on 2026-10-04.
