# Handoff — Rewards referral wiring (pass ref into fcl-verify) — 2026-06-04 (refreshed)

PLAIN TEXT (iPhone copy-paste). No triple-backticks. Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual file shape. Direct to main, no branches/PRs.

REFRESHED 2026-06-04 against the actually-shipped code (commit c689771). Material change from the first draft: the SERVER side is more done than assumed — app/api/auth/fcl-verify/route.ts already reads body.ref AND already blocks self-referral. So the remaining work is almost entirely client-side: capture the ref and pass it into the verify fetch. Item 3 shrank to one optional check.

================================================================
CONTEXT — what's already live vs. what's left
================================================================
Verified by reading the shipped files (2026-06-04):

app/api/auth/fcl-verify/route.ts — on the minted (genuinely-new-user) path (~L160-177) it already does:
  const referrer = typeof body?.ref === "string" ? body.ref.trim() : "";
  if (referrer && referrer !== newUserId) { await awardPoints(referrer, "referral_verified", newUserId); }
So: reading body.ref = DONE. Self-referral guard (referrer !== newUserId) = DONE. minted-path-only = DONE. newUserId comes from userRow?.users?.[0]?.id. Imports already present: supabaseAdmin as supabase (@/lib/supabase), getCurrentUser (@/lib/auth/supabase-server), awardPoints (@/lib/rewards).

components/SignInWithDapper.tsx — the verify call (~L51-62) posts body: JSON.stringify({ addr, accountProof: { address: addr, nonce, signatures } }). There is NO ref field. THIS is the gap.

Net: the referral award is live but can never fire because the client never sends ref. The whole job is (Item 1) capture ?ref on landing, (Item 2) add ref to that one fetch body, plus (Item 4) a share-link UI. Item 3 is one optional server hardening line.

================================================================
ITEM 1 (P1) — capture ?ref on landing: components/RefCapture.tsx  [NEW] + mount in root layout
================================================================
A tiny client component that, on first load, reads ?ref from the URL and stashes it so it survives the user navigating to /profile and signing in.

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

Mount <RefCapture /> once high in the tree so it runs on any landing page — app/layout.tsx body, or the existing top-level client providers component if the root layout is a server component. It renders nothing.

Revert: remove the mount and delete components/RefCapture.tsx.

================================================================
ITEM 2 (P1 — THE core change) — send ref in the verify fetch: components/SignInWithDapper.tsx  [EDIT]
================================================================
At the fetch to /api/auth/fcl-verify (~L51-62), the body object is currently:
  body: JSON.stringify({ addr, accountProof: { address: addr, nonce: data.nonce, signatures: data.signatures } })
Add a ref field read from localStorage, so it becomes:
  body: JSON.stringify({ addr, accountProof: { address: addr, nonce: data.nonce, signatures: data.signatures }, ref: (typeof window !== "undefined" && localStorage.getItem("rpc_ref")) || undefined })

Then, AFTER a successful response on the minted path (where the component already handles the verifyOtp / new-session branch), clear the stash so a ref can't be reused:
  try { localStorage.removeItem("rpc_ref") } catch {}

The server already ignores ref on the linked (returning-user) path and already blocks self-referral, so passing ref unconditionally is safe. This single edit is what activates referrals. Revert: remove the ref field + the removeItem line (git revert the commit).

================================================================
ITEM 3 (P2 — optional hardening) — validate the referrer exists: app/api/auth/fcl-verify/route.ts  [SMALL EDIT]
================================================================
Already done: self-referral block + minted-path-only. Optional add: before awarding, confirm the referrer is a real user so a forged ?ref uuid can't mint an orphan ledger row (user_id has no FK). At the existing referral block (~L173-176), gate the award on a quick existence check using the already-imported supabase (supabaseAdmin):
  if (referrer && referrer !== newUserId) {
    const { data: refUser } = await supabase.from("user_profiles").select("id").eq("id", referrer).maybeSingle()
    if (refUser) { await awardPoints(referrer, "referral_verified", newUserId) }
  }
Keep it fire-and-forget — never fail wallet verification because of a rewards write. Skip this item if you'd rather keep the path minimal; it's hardening, not correctness. Revert: restore the prior two-line block.

================================================================
ITEM 4 (P2) — referral link UI on /rewards  [EDIT app/rewards]
================================================================
On the /rewards hub add an "Invite a collector" block:
- Link: `${window.location.origin}/?ref=${currentUserId}` with a Copy button. currentUserId is the signed-in user id already resolved on this page (pass it to the client block).
- Referral count: number of referral_verified earns credited to this user. Easiest: add to /api/rewards/summary a field — select count(*) from points_ledger where user_id = <me> and reason = 'referral_verified' — and render "X friends joined · earned Y credits" (Y = X * 300).
- Copy: "Share your link. When a collector links a verified wallet through it, you earn 300 credits."
Brand tokens (var(--rpc-red), var(--font-display), var(--font-mono)); match existing /rewards styling. Revert: remove the block (+ the optional summary count).

================================================================
GUARDRAILS
================================================================
- Direct to main, no branches/PRs. If a claude/* branch is checked out, switch to main first.
- Commit via PowerShell git on Windows; after push, git rev-list --count origin/main..HEAD must be 0.
- CRLF: full-file write for the new RefCapture.tsx; for the SignInWithDapper / fcl-verify edits use findIndex-on-split-lines or sed line targeting, not a raw string-replace.
- Supabase client typed as any in routes.

================================================================
VERIFICATION
================================================================
- npx tsc --noEmit clean; Vercel deploy READY.
- Fresh browser: open www.rippackscity.com/?ref=<an-existing-user-uuid>, then sign up + verify a NEW Dapper wallet -> that referrer gains +300 (confirm a referral_verified ledger row for the referrer in the rpc-rewards-console artifact).
- Self-referral: land on your own ?ref=<your-id>, verify -> no award (already guarded server-side).
- Returning user verifying with a stale rpc_ref -> no award, no error (linked path ignores ref).
- If Item 3 added: a forged ?ref=<random-uuid> -> no award (referrer not in user_profiles).

================================================================
END STATE
================================================================
One commit on main, deploy READY. The server already credits referrals on new-user verifies and blocks self-referral; this handoff supplies the missing client half — capture ?ref, persist it, send it in the one verify fetch — plus a share-link UI on /rewards. That activates the referral_verified earn that's been live-but-dormant since c689771: the acquisition flywheel from the strategy doc.
