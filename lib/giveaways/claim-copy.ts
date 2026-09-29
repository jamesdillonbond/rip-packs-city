// lib/giveaways/claim-copy.ts
//
// One response per claim outcome (claim_giveaway_pack). Kept apart from the
// route so every branch is unit-tested and so the copy lives in one place.

import { NextResponse } from "next/server"
import type { ClaimOutcome } from "@/lib/giveaways/store"

const COPY: Record<ClaimOutcome, { status: number; message: string }> = {
  claimed: { status: 200, message: "Pack claimed." },
  already_claimed: { status: 200, message: "You've already claimed a pack from this giveaway." },
  not_found: { status: 404, message: "No such giveaway." },
  not_open: { status: 409, message: "This giveaway isn't taking claims right now." },
  admin_recipient: { status: 400, message: "The sponsor can't claim a pack from their own giveaway." },
  recipient_taken: { status: 409, message: "That Top Shot account has already claimed a pack from this giveaway." },
  all_claimed: { status: 409, message: "Every pack has been claimed." },
}

export function claimOutcomeResponse(outcome: ClaimOutcome, packNo: number | null): NextResponse {
  const c = COPY[outcome]
  const ok = outcome === "claimed" || outcome === "already_claimed"
  return NextResponse.json(
    ok ? { ok: true, outcome, pack_no: packNo, message: c.message } : { ok: false, outcome, error: c.message, code: outcome },
    { status: c.status, headers: { "Cache-Control": "no-store" } },
  )
}
