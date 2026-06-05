# Handoff — Rewards referral wiring (pass ref into fcl-verify) — 2026-06-04

PLAIN TEXT (iPhone copy-paste). No triple-backticks. Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual file shape. Direct to main, no branches/PRs.

================================================================
CONTEXT
================================================================
The rewards program is live (commit c689771). The server side of referrals already works: app/api/auth/fcl-verify/route.ts awards referral_verified (300 pts) to body.ref, and only on the minted (genuinely-new-user) path so it can't be farmed by re-verifying. What's missing is the CLIENT plumbing: nothing captures a referrer from the URL or passes ref into the verify call, and there's no "share your referral link" UI. This handoff wires those three gaps. No DB or migration work — the rule and the award are already live.

Verified files (grep, 2026-06-04): components/SignInWithDapper.tsx is the client call site for /api/auth/fcl-verify. app/api/auth/fcl-verify/route.ts holds the award. app/rewards/* is the user hub (shipped c689771).

Design choice for v1: the referral link carries the referrer's user_id (a uuid) as ?ref=. A uuid is opaque and safe to expose (it can't be used to act as that user). A prettier username-based code is a later nicety (would need a username->user_id resolve server-side); skip for v1.

================================================================
ITEM 1 (P1) — capture ?ref on landing: components/RefCapture.tsx  [NEW] + mount in root layout
================================================================
A tiny client component that, on first load, reads ?ref from the URL and stashes it so it survives the user navigating to login and verifying.

FILE: components/RefCapture.tsx

"use client"
import { useEffect } from "react"
export default function RefCapture() {
  useEffect(() => {
    try {
      const ref = new URLSearchParams(window.location.search).get("ref")
      if (ref && /^[0-9a-f-]{36}$/i.test(ref) && !localStorage.getItem("rpc_ref")) {
        localStorage.setItem("rpc_ref", ref)
      }
    } catch {}
  }, [])
  return null
}

Mount it once high in the tree so it runs on any landing page. Put <RefCapture /> in the root app/layout.tsx body (or the existing top-level client providers component if the root layout is a server component — find where other client-only providers mount and add it there). It renders nothing.

Revert: remove the <RefCapture /> mount and delete components/RefCapture.tsx.

================================================================
ITEM 2 (P1) — pass ref into the verify call: components/SignInWithDapper.tsx  [EDIT]
================================================================
Find where this component POSTs to /api/auth/fcl-verify (the fetch with the signed message / address payload). Add the stored ref to that request body. Do not restructure the component.

At the point the body object is built for the fcl-verify fetch, add a ref field, e.g.:
  const ref = (typeof window !== "undefined" && localStorage.getItem("rpc_ref")) || undefined
  ... body: JSON.stringify({ ...existingFields, ref })

After a SUCCESSFUL verify response (i.e., the account is created/verified), clear it so it can't be reused:
  try { localStorage.removeItem("rpc_ref") } catch {}

The server already ignores ref except on the brand-new-user path, so passing it on a returning-user verify is harmless. Revert: remove the two lines (git revert the commit).

================================================================
ITEM 3 (P1) — server guards in app/api/auth/fcl-verify/route.ts  [EDIT, small]
================================================================
You already award referral_verified to body.ref on the minted path. Add two guards right where that awardPoints(refUserId, "referral_verified", newUserId) call is, so a user can't refer themselves and a bad ref can't mint phantom points:

- Self-referral: only award if body.ref && body.ref !== <the newly created user's id>.
- Valid referrer: only award if body.ref matches an existing row in user_profiles (a quick supabaseAdmin.from("user_profiles").select("id").eq("id", body.ref).maybeSingle() before awarding). Skip the award (don't error the verify) if it doesn't resolve.

These are guard conditions around the existing call — describe-by-location, not a rewrite. Keep the award fire-and-forget (never block or fail wallet verification because of a rewards write). Revert: remove the guard conditions.

================================================================
ITEM 4 (P2) — referral link UI on /rewards  [EDIT app/rewards]
================================================================
On the /rewards hub, add a small "Invite a collector" block:
- The link: `${window.location.origin}/?ref=${currentUserId}` with a Copy button. currentUserId is the signed-in user's id (already available server-side on this page; pass it to the client block).
- Referral count: number of referral_verified earns credited to this user. Either read it from the summary payload or add to /api/rewards/summary a count: select count(*) from points_ledger where user_id = <me> and reason = 'referral_verified'. Show "X friends joined · earned Y credits".
- Copy: "Share your link. When a collector links a verified wallet through it, you earn 300 credits."

Brand tokens (var(--rpc-red), var(--font-display), var(--font-mono)); match the existing /rewards styling. Revert: remove the block (+ the optional summary count).

================================================================
GUARDRAILS
================================================================
- Direct to main, no branches/PRs. If a claude/* branch is checked out, switch to main first.
- Commit via PowerShell git on Windows; after push, git rev-list --count origin/main..HEAD must be 0.
- CRLF: full-file writes for new files; for the SignInWithDapper / fcl-verify edits use findIndex-on-split-lines or sed line targeting, not a raw string-replace.
- Supabase client typed as any in routes.

================================================================
VERIFICATION
================================================================
- npx tsc --noEmit clean; Vercel deploy READY.
- Open www.rippackscity.com/?ref=<some-existing-user-uuid> in a fresh browser, then sign up + verify a NEW wallet -> that referrer's balance shows +300 (check the rpc-rewards-console artifact: a referral_verified ledger row for the referrer).
- Verify self-referral does nothing: land on your own ?ref=<your-id>, verify -> no award.
- Returning user verifying with a stale rpc_ref -> no award, no error.

================================================================
END STATE
================================================================
One commit on main, deploy READY. Referral links capture -> persist -> pass through verify -> credit the referrer once, on genuinely-new-user signups only, self-referral blocked. /rewards shows each user their link + referral count. This activates the referral_verified earn that's been live-but-dormant since c689771 — the acquisition flywheel from the strategy doc.
