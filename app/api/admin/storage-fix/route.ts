// app/api/admin/storage-fix/route.ts
//
// Trevor-only (RPC_ADMIN_TOKEN). The read-only check behind /admin/storage-fix
// (lib/storage-fix/check.ts, 2026-11-05): a Flow account's storage state, whether it is a
// Dapper wallet, what would fix it, and when its capacity last changed (so nobody pays to
// fix an account Dapper already refilled). RPC signs nothing here: the console's connected
// Flow Wallet signs, in the browser, one of the two pinned texts in lib/storage-fix/cadence.ts.
//
//   GET ?address=0x…                                  -> { check }
//   GET ?address=0x…&simulate_from=0x…&amount=0.02     -> { check } with check.simulation: the
//       fix run as a read-only script at the same sealed block, signed as the operator's wallet

import { NextRequest, NextResponse } from "next/server"
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth"
import { apiErrorResponse } from "@/lib/api-error"
import { checkStorage, StorageFixError } from "@/lib/storage-fix/check"

export const dynamic = "force-dynamic"
// one state read + a bounded history search (lib/storage-fix/check.ts HISTORY_DEADLINE_MS)
export const maxDuration = 60

export async function GET(req: NextRequest) {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse()
  try {
    const q = req.nextUrl.searchParams
    const from = q.get("simulate_from")
    return NextResponse.json({
      check: await checkStorage(q.get("address") ?? "", fetch, from ? { simulate: { from, amount: q.get("amount") } } : {}),
    })
  } catch (e) {
    if (e instanceof StorageFixError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status })
    return apiErrorResponse(e, "api/admin/storage-fix GET")
  }
}
