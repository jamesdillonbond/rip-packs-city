// app/api/physical/cert/route.ts
//
// Physical cards (prototype): resolve a slab from grader + cert number.
//   GET ?grader=psa&cert=12345678 → { slab } | 400 | 401 | 404 (feature off) | 429 | 502
//
// OFF (404) unless PHYSICAL_CARDS=1 and HCI_API_KEY are set — merging this
// changes nothing. Signed-in only: every call spends a paid cert lookup
// (HobbyCardIndex Lite: 150/month), so it is capped per user AND site-wide via
// the durable counter (bump_anon_action_rate — fails closed).
//
// Returns identity only. Values come from physical_value_cache, never from
// this route, so a cert lookup cannot leak a price the cache would not show.

import { NextRequest, NextResponse } from "next/server"
import { requireUser } from "@/lib/auth/supabase-server"
import { bumpAnonRates } from "@/lib/abuse/anon-rate"
import { physicalEnabled, certCaps } from "@/lib/physical/flags"
import { parseCertInput, mapHciCert } from "@/lib/physical/cert"
import { HciClient } from "@/lib/physical/hci-client"

export const dynamic = "force-dynamic"
const NO_STORE = { "Cache-Control": "no-store" }
const DAY = 86_400

export async function GET(req: NextRequest) {
  if (!physicalEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE })

  const input = parseCertInput(req.nextUrl.searchParams.get("cert") ?? "", req.nextUrl.searchParams.get("grader") ?? undefined)
  if (!input) {
    return NextResponse.json({ error: "Enter the grader (PSA, BGS, CGC or SGC) and the cert number on the slab." }, { status: 400, headers: NO_STORE })
  }

  let user
  try {
    user = await requireUser()
  } catch (res) {
    return res as Response
  }

  const caps = certCaps()
  // Order is deliberate (review finding 7): the per-user cap first, so a user over
  // their own limit never spends the scarce site-wide (paid) budget. The cost is that
  // a global refusal still spends one of that user's lookups — the safe direction.
  const verdict = await bumpAnonRates([
    { bucket: "physical_cert_user", key: user.id, limit: caps.perUser, windowSecs: DAY },
    { bucket: "physical_cert_global", key: "*", limit: caps.global, windowSecs: DAY },
  ])
  if (!verdict.allowed) {
    return NextResponse.json(
      { error: verdict.failed ? "Cert lookup is unavailable right now." : "Daily cert lookup limit reached. Try again tomorrow." },
      { status: verdict.failed ? 503 : 429, headers: NO_STORE },
    )
  }

  const r = await new HciClient(process.env.HCI_API_KEY as string).cert(input)
  if (!r.ok) {
    if (r.status === 404) return NextResponse.json({ error: "That cert number was not found." }, { status: 404, headers: NO_STORE })
    // The feed's own rate limit is a busy signal, not a broken upstream (review finding 7).
    if (r.status === 429) {
      return NextResponse.json({ error: "Cert lookup is busy. Try again in a minute." }, { status: 429, headers: { ...NO_STORE, "Retry-After": "60" } })
    }
    return NextResponse.json({ error: "Cert lookup failed. Try again later." }, { status: 502, headers: NO_STORE })
  }
  const slab = mapHciCert(r.data, input)
  if (!slab) return NextResponse.json({ error: "That cert number was not found." }, { status: 404, headers: NO_STORE })
  return NextResponse.json({ slab }, { headers: NO_STORE })
}
