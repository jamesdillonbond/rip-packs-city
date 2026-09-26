// app/api/candy/resolve-name/route.ts
//
// GET /api/candy/resolve-name?q=<alice.sns | alice.sol>
//
// Resolves a Solana Name Service name to the Solana wallet it points at, for
// the Candy MLB Collection tab's search box (2026-09-25). See
// lib/chains/solana/sns.ts for why this — and not a "Candy username" or an RPC
// username — is the name source.
//
//   200 { wallet, source: "sns", name }  — resolved (wallet verbatim, base58)
//   400 { error: "not_a_name" }          — input is not an SNS name
//   404 { error: "name_not_found" }      — the name does not resolve (about the NAME)
//   503 { error: "lookup_unavailable" }  — the lookup failed (about US), never "not found"
//
// Anon-public (the Collection tab is): GET-only, no session, no DB — a public
// on-chain name lookup.

import { NextRequest, NextResponse } from "next/server"
import { parseSnsName, resolveSnsName } from "@/lib/chains/solana/sns"

export async function GET(req: NextRequest) {
  const name = parseSnsName(req.nextUrl.searchParams.get("q"))
  if (!name) {
    return NextResponse.json(
      { error: "not_a_name", message: "Enter a Solana wallet address or an SNS name like alice.sns." },
      { status: 400 },
    )
  }
  const r = await resolveSnsName(name)
  if (r.kind === "resolved") {
    return NextResponse.json(
      { wallet: r.wallet, source: "sns", name },
      { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60" } },
    )
  }
  if (r.kind === "not_found") {
    return NextResponse.json(
      { error: "name_not_found", message: `${name} doesn't point at a Solana wallet.` },
      { status: 404, headers: { "Cache-Control": "public, s-maxage=60" } },
    )
  }
  console.log(`[candy/resolve-name] lookup failed for ${name}: ${r.reason}`)
  return NextResponse.json(
    { error: "lookup_unavailable", retry: true, message: "Couldn't look up that name right now. Try again, or paste the wallet address." },
    { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "30" } },
  )
}
